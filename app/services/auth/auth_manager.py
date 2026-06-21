"""Authentication manager for Aurora.

Business logic for user authentication, token management, device pairing,
and credential persistence.  All DB operations go through the message bus
so the Auth service never directly imports from the DB service.
"""

from __future__ import annotations

import hashlib
import json
import secrets
import uuid
from datetime import datetime, timedelta
from typing import Any

from passlib.context import CryptContext

from app.helpers.aurora_logger import log_error, log_info, log_warning
from app.messaging.bus import MessageBus
from app.shared.auth.identity import SYSTEM, Identity, build_identity
from app.shared.auth.permissions import has_permission
from app.shared.contracts.models.auth import (
    AuthMethods,
    PairingLifecycleEvent,
)
from app.shared.contracts.models.db import (
    DBAuditLogRequest,
    DBCountAuditEventsRequest,
    DBCountUsersRequest,
    DBCreateDeviceRequest,
    DBCreateTokenRequest,
    DBCreateUserRequest,
    DBDeleteDeviceRequest,
    DBDeleteMeshCredentialRequest,
    DBDeleteUserRequest,
    DBExecuteSQLRequest,
    DBGetDeviceByIdRequest,
    DBGetMeshCredentialByRoomRequest,
    DBGetTokenByHashRequest,
    DBGetTokenByIdRequest,
    DBGetUserByIdRequest,
    DBGetUserByUsernameRequest,
    DBListDevicesRequest,
    DBListTokensRequest,
    DBListUsersRequest,
    DBMethods,
    DBRevokeTokenRequest,
    DBSaveMeshCredentialRequest,
    DBUpdateTokenScopesRequest,
    DBUpdateUserRequest,
)
from app.shared.crypto import derive_mesh_inbound_key, open_str, seal_str
from app.shared.models.db import Device, MeshCredential, Token, User

# Password hashing configuration
pwd_context = CryptContext(schemes=["argon2"], deprecated="auto")

# Default timeout for DB bus requests (seconds)
_DB_TIMEOUT = 10.0


class AuthManager:
    """Core authentication logic — delegates all DB operations to the bus."""

    def __init__(self, bus: MessageBus) -> None:
        self.bus = bus
        self.pairing_requests: dict[str, dict[str, Any]] = {}
        self.pairing_attempts: dict[str, int] = {}
        self._default_device_permissions: list[str] = []
        self.login_attempts: dict[str, int] = {}
        self._mesh_inbound_key: bytes | None = None

    def invalidate_mesh_inbound_key_cache(self) -> None:
        """Clear cached mesh crypto key after services.gateway.api.token_secret changes."""
        self._mesh_inbound_key = None

    async def _aget_mesh_inbound_key(self) -> bytes:
        """Lazy-load encryption key for inbound tokens via ConfigService (bus).

        Must use ``aget`` — sync ``ConfigAPI.get()`` returns default when called
        from async context and would derive the wrong key.
        """
        if self._mesh_inbound_key is not None:
            return self._mesh_inbound_key
        from app.shared.config.interface import ConfigAPI

        config = ConfigAPI()
        from app.shared.config.keys import ConfigKeys

        secret = await config.aget(
            ConfigKeys.services.gateway.api.token_secret, default="", config_timeout=15.0
        )
        self._mesh_inbound_key = derive_mesh_inbound_key(secret or "")
        return self._mesh_inbound_key

    # ── Bus helpers ──────────────────────────────────────────────────────

    async def _db_request(self, topic: str, payload: Any, timeout: float = _DB_TIMEOUT) -> Any:
        """Send a request to the DB service and return result.data or None."""
        result = await self.bus.request(topic, payload, timeout=timeout)
        if result.ok:
            return result.data
        log_error(f"DB request {topic} failed: {result.error}")
        return None

    async def _get_user_by_username(self, username: str) -> User | None:
        data = await self._db_request(
            DBMethods.GET_USER_BY_USERNAME,
            DBGetUserByUsernameRequest(username=username),
        )
        if data and data.get("user"):
            return User.from_dict(data["user"])
        return None

    async def _get_user_by_id(self, user_id: str) -> User | None:
        data = await self._db_request(
            DBMethods.GET_USER_BY_ID,
            DBGetUserByIdRequest(user_id=user_id),
        )
        if data and data.get("user"):
            return User.from_dict(data["user"])
        return None

    async def _create_user(self, user: User) -> bool:
        data = await self._db_request(
            DBMethods.CREATE_USER,
            DBCreateUserRequest(
                id=user.id,
                username=user.username,
                password_hash=user.password_hash,
                role=user.role,
                permissions=user.permissions or [],
                is_admin=user.is_admin,
                created_at=user.created_at.isoformat() if user.created_at else None,
            ),
        )
        return bool(data and data.get("success"))

    async def _count_users(self) -> int:
        data = await self._db_request(
            DBMethods.COUNT_USERS,
            DBCountUsersRequest(),
        )
        return data.get("count", 0) if data else 0

    async def _list_users(self) -> list[User]:
        data = await self._db_request(
            DBMethods.LIST_USERS,
            DBListUsersRequest(),
        )
        if data and data.get("users"):
            return [User.from_dict(u) for u in data["users"]]
        return []

    async def _update_user(self, user_id: str, **fields: Any) -> bool:
        data = await self._db_request(
            DBMethods.UPDATE_USER,
            DBUpdateUserRequest(user_id=user_id, fields=fields),
        )
        return bool(data and data.get("success"))

    async def _delete_user(self, user_id: str) -> bool:
        data = await self._db_request(
            DBMethods.DELETE_USER,
            DBDeleteUserRequest(user_id=user_id),
        )
        return bool(data and data.get("success"))

    async def _create_device(self, device: Device) -> bool:
        data = await self._db_request(
            DBMethods.CREATE_DEVICE,
            DBCreateDeviceRequest(
                id=device.id,
                user_id=device.user_id,
                name=device.name,
                public_key=device.public_key,
                is_trusted=device.is_trusted,
            ),
        )
        return bool(data and data.get("success"))

    async def _get_device_by_id(self, device_id: str) -> Device | None:
        data = await self._db_request(
            DBMethods.GET_DEVICE_BY_ID,
            DBGetDeviceByIdRequest(device_id=device_id),
        )
        if data and data.get("device"):
            return Device.from_dict(data["device"])
        return None

    async def _list_devices(self, user_id: str | None = None) -> list[Device]:
        data = await self._db_request(
            DBMethods.LIST_DEVICES,
            DBListDevicesRequest(user_id=user_id),
        )
        if data and data.get("devices"):
            return [Device.from_dict(d) for d in data["devices"]]
        return []

    async def _delete_device(self, device_id: str) -> bool:
        data = await self._db_request(
            DBMethods.DELETE_DEVICE,
            DBDeleteDeviceRequest(device_id=device_id),
        )
        return bool(data and data.get("success"))

    async def _create_token(self, token: Token) -> bool:
        data = await self._db_request(
            DBMethods.CREATE_TOKEN,
            DBCreateTokenRequest(
                id=token.id,
                token_hash=token.token_hash,
                prefix=token.prefix,
                device_id=token.device_id,
                user_id=token.user_id,
                scopes=token.scopes or [],
                expires_at=token.expires_at.isoformat() if token.expires_at else None,
            ),
        )
        return bool(data and data.get("success"))

    async def _get_token_by_hash(self, token_hash: str) -> Token | None:
        data = await self._db_request(
            DBMethods.GET_TOKEN_BY_HASH,
            DBGetTokenByHashRequest(token_hash=token_hash),
        )
        if data and data.get("token"):
            return Token.from_dict(data["token"])
        return None

    async def _get_token_by_id(self, token_id: str) -> Token | None:
        data = await self._db_request(
            DBMethods.GET_TOKEN_BY_ID,
            DBGetTokenByIdRequest(token_id=token_id),
        )
        if data and data.get("token"):
            return Token.from_dict(data["token"])
        return None

    async def _list_tokens(
        self, user_id: str | None = None, device_id: str | None = None
    ) -> list[Token]:
        data = await self._db_request(
            DBMethods.LIST_TOKENS,
            DBListTokensRequest(user_id=user_id, device_id=device_id),
        )
        if data and data.get("tokens"):
            return [Token.from_dict(t) for t in data["tokens"]]
        return []

    async def _update_token_scopes(self, token_id: str, scopes: list[str]) -> bool:
        data = await self._db_request(
            DBMethods.UPDATE_TOKEN_SCOPES,
            DBUpdateTokenScopesRequest(token_id=token_id, scopes=scopes),
        )
        return bool(data and data.get("success"))

    async def _revoke_token(self, token_id: str) -> bool:
        data = await self._db_request(
            DBMethods.REVOKE_TOKEN,
            DBRevokeTokenRequest(token_id=token_id),
        )
        return bool(data and data.get("success"))

    async def _get_audit_log(
        self,
        limit: int = 50,
        offset: int = 0,
        principal_id: str | None = None,
        event: str | None = None,
    ) -> list[dict[str, Any]]:
        data = await self._db_request(
            DBMethods.GET_AUDIT_LOG,
            DBAuditLogRequest(limit=limit, offset=offset, principal_id=principal_id, event=event),
        )
        if data and data.get("events"):
            return data["events"]
        return []

    async def _count_audit_events(
        self, principal_id: str | None = None, event: str | None = None
    ) -> int:
        data = await self._db_request(
            DBMethods.COUNT_AUDIT_EVENTS,
            DBCountAuditEventsRequest(principal_id=principal_id, event=event),
        )
        return data.get("count", 0) if data else 0

    async def _save_mesh_credential(self, credential: MeshCredential) -> bool:
        data = await self._db_request(
            DBMethods.SAVE_MESH_CREDENTIAL,
            DBSaveMeshCredentialRequest(
                id=credential.id,
                room_name=credential.room_name,
                token=credential.token,
                remote_device_id=credential.remote_device_id,
                remote_user_id=credential.remote_user_id,
            ),
        )
        return bool(data and data.get("success"))

    async def _get_mesh_credential_by_room(self, room_name: str) -> MeshCredential | None:
        data = await self._db_request(
            DBMethods.GET_MESH_CREDENTIAL_BY_ROOM,
            DBGetMeshCredentialByRoomRequest(room_name=room_name),
        )
        if data and data.get("credential"):
            return MeshCredential.from_dict(data["credential"])
        return None

    async def _delete_mesh_credential(self, room_name: str) -> bool:
        data = await self._db_request(
            DBMethods.DELETE_MESH_CREDENTIAL,
            DBDeleteMeshCredentialRequest(room_name=room_name),
        )
        return bool(data and data.get("success"))

    # ── Lifecycle ────────────────────────────────────────────────────────

    async def initialize(self) -> None:
        """Initialize the auth manager and bootstrap if needed."""
        await self._bootstrap_admin()
        await self._bootstrap_system_token()
        await self._migrate_permissions_to_bus_topics()

    # ── Bootstrap ────────────────────────────────────────────────────────

    async def _bootstrap_system_token(self) -> None:
        """Create a system token for internal service use if it doesn't exist."""
        try:
            system_user = await self._get_user_by_username("system")
            if not system_user:
                system_user = User(
                    id="system-user-id",
                    username="system",
                    password_hash="SYSTEM_NO_PASSWORD",
                    role="admin",
                    permissions=["*"],
                    is_admin=True,
                )
                await self._create_user(system_user)

            system_device = await self._get_device_by_id("system-device-id")
            if not system_device:
                system_device = Device(
                    id="system-device-id",
                    user_id=system_user.id,
                    name="System Gateway",
                    is_trusted=True,
                )
                await self._create_device(system_device)

            token_str = "GATEWAY_INTERNAL_TOKEN"
            token_hash = hashlib.sha256(token_str.encode()).hexdigest()
            existing_token = await self._get_token_by_hash(token_hash)

            if not existing_token:
                token = Token(
                    id="system-token-id",
                    token_hash=token_hash,
                    prefix=token_str[:8],
                    device_id=system_device.id,
                    user_id=system_user.id,
                    scopes=["all"],
                    expires_at=datetime.now() + timedelta(days=3650),
                )
                await self._create_token(token)
                log_info("System token bootstrapped")
        except Exception as e:
            log_error(f"Error bootstrapping system token: {e}")

    async def get_system_token(self) -> str:
        return "GATEWAY_INTERNAL_TOKEN"

    async def _bootstrap_admin(self) -> None:
        """Create initial admin user if no users exist."""
        try:
            user_count = await self._count_users()
            if user_count == 0:
                admin_username = "admin"
                admin_password = secrets.token_urlsafe(12)
                hashed_password = pwd_context.hash(admin_password)

                admin_user = User(
                    id=str(uuid.uuid4()),
                    username=admin_username,
                    password_hash=hashed_password,
                    role="admin",
                    permissions=["*"],
                    is_admin=True,
                )

                success = await self._create_user(admin_user)
                if success:
                    log_info("=" * 50)
                    log_info("BOOTSTRAP: Initial admin user created")
                    log_info(f"Username: {admin_username}")
                    log_info(f"Password: {admin_password}")
                    log_info("=" * 50)
                else:
                    log_error("Failed to bootstrap admin user")
        except Exception as e:
            log_error(f"Error during admin bootstrapping: {e}")

    # ── Permission Migration ─────────────────────────────────────────────

    # Migration map: old lowercase permissions → new PascalCase bus topic perms
    _PERM_MIGRATION_MAP: dict[str, str] = {
        "auth.manage": "Auth.manage",
        "auth.approve": "Auth.manage",
        "auth.audit": "Auth.manage",
        "auth.*": "Auth.*",
        "tts.request": "TTS.use",
        "tts.stop": "TTS.use",
        "tts.pause": "TTS.use",
        "tts.resume": "TTS.use",
        "tts.*": "TTS.*",
        "stt.start": "STTCoordinator.use",
        "stt.stop": "STTCoordinator.use",
        "stt.*": "STTCoordinator.*",
        "orchestrator.query": "Orchestrator.use",
        "orchestrator.*": "Orchestrator.*",
        "db.read": "DB.use",
        "db.write": "DB.manage",
        "db.*": "DB.*",
        "config.read": "Config.use",
        "config.write": "Config.manage",
        "config.*": "Config.*",
        "system.control": "Config.manage",
        "system.restart": "Config.manage",
        "system.*": "Config.*",
        "gateway.mesh": "Gateway.use",
        "gateway.api": "Gateway.use",
        "gateway.*": "Gateway.*",
        "tooling.execute": "Tooling.use",
        "tooling.list": "Tooling.use",
        "tooling.*": "Tooling.*",
        "scheduler.create": "Scheduler.manage",
        "scheduler.delete": "Scheduler.manage",
        "scheduler.*": "Scheduler.*",
        "mesh.list": "Auth.use",
        "mesh.approve": "Auth.manage",
        "mesh.manage": "Auth.manage",
        "mesh.*": "Auth.*",
    }

    async def _migrate_permissions_to_bus_topics(self) -> None:
        """One-time migration of old lowercase permissions to PascalCase bus topics.

        Scans all users and tokens. If any permission matches the old format,
        converts it to the new format and persists the change.
        """
        try:
            users = await self._list_users()
            migrated_count = 0
            for user in users:
                if not user.permissions:
                    continue
                new_perms = self._migrate_perm_list(user.permissions)
                if new_perms != user.permissions:
                    await self._update_user(user.id, permissions=new_perms)
                    migrated_count += 1
                    log_info(
                        f"Migrated permissions for user '{user.username}': "
                        f"{user.permissions} → {new_perms}"
                    )

            if migrated_count > 0:
                log_info(f"Permission migration complete: {migrated_count} user(s) updated")
        except Exception as e:
            log_error(f"Error during permission migration: {e}")

    @classmethod
    def _migrate_perm_list(cls, perms: list[str]) -> list[str]:
        """Convert a list of permissions from old to new format.

        Permissions already in PascalCase format (containing an uppercase
        letter) are left unchanged. The ``"*"`` wildcard is always preserved.

        Args:
            perms: Original permission list.

        Returns:
            New permission list with old-format entries replaced.
        """
        result: list[str] = []
        seen: set[str] = set()
        for perm in perms:
            if perm == "*":
                new_perm = "*"
            elif perm in cls._PERM_MIGRATION_MAP:
                new_perm = cls._PERM_MIGRATION_MAP[perm]
            else:
                new_perm = perm  # Already in new format or unknown
            if new_perm not in seen:
                result.append(new_perm)
                seen.add(new_perm)
        return result

    # ── Authentication ───────────────────────────────────────────────────

    async def authenticate_user(self, username: str, password: str) -> User | None:
        user = await self._get_user_by_username(username)
        if user and pwd_context.verify(password, user.password_hash):
            return user
        return None

    async def authenticate_token(self, token_str: str) -> Token | None:
        token_hash = hashlib.sha256(token_str.encode()).hexdigest()
        token = await self._get_token_by_hash(token_hash)

        if token:
            if token.expires_at and token.expires_at < datetime.now():
                log_warning(f"Token {token.id} has expired")
                await self._revoke_token(token.id)
                return None
            return token
        return None

    # ── Pairing ──────────────────────────────────────────────────────────

    async def start_pairing(
        self,
        device_name: str,
        client_ip: str,
        remote_peer_id: str = "",
        remote_node_name: str = "",
    ) -> str | None:
        if self.pairing_attempts.get(client_ip, 0) >= 5:
            log_warning(f"Pairing rate limit exceeded for IP: {client_ip}")
            return None

        pairing_code = "".join(secrets.choice("0123456789") for _ in range(6))
        request_id = str(uuid.uuid4())

        self.pairing_requests[pairing_code] = {
            "id": request_id,
            "device_name": device_name,
            "client_ip": client_ip,
            "status": "pending",
            "created_at": datetime.now(),
            "expires_at": datetime.now() + timedelta(minutes=5),
            "approved_by": None,
            "remote_peer_id": remote_peer_id,
            "remote_node_name": remote_node_name,
        }

        self.pairing_attempts[client_ip] = self.pairing_attempts.get(client_ip, 0) + 1

        log_info(
            f"Pairing started for device '{device_name}' (IP: {client_ip}). Code: {pairing_code}"
        )

        # Publish PairingRequestedEvent so UI / mesh subsystem can react
        try:
            from app.shared.contracts.models.auth import AuthMethods
            from app.shared.contracts.models.mesh import PairingRequestedEvent

            await self.bus.publish(
                AuthMethods.PAIRING_REQUESTED,
                PairingRequestedEvent(
                    code_sha256=hashlib.sha256(pairing_code.encode()).hexdigest(),
                    remote_peer_id=remote_peer_id,
                    remote_node_name=remote_node_name,
                    device_name=device_name,
                    client_ip=client_ip,
                    expires_at=(datetime.now() + timedelta(minutes=5)).isoformat(),
                ),
                event=True,
                origin="internal",
            )
        except Exception as e:
            log_warning(f"Failed to publish PairingRequestedEvent: {e}")

        return pairing_code

    async def list_pending_pairings(
        self, include_non_pending: bool = False
    ) -> tuple[list[dict[str, Any]], int]:
        expired_count = await self._prune_expired_pairings()
        pairings: list[dict[str, Any]] = []
        for code, request in sorted(
            self.pairing_requests.items(),
            key=lambda item: item[1].get("created_at", item[1].get("expires_at", datetime.max)),
        ):
            if not include_non_pending and request.get("status") != "pending":
                continue
            pairings.append(self._pending_pairing_entry(code, request))
        return pairings, expired_count

    async def connect_pairing(self, pairing_code: str) -> dict[str, Any] | None:
        request = self.pairing_requests.get(pairing_code)
        if not request:
            return None

        if request["expires_at"] < datetime.now():
            await self._expire_pairing(pairing_code, request)
            return None

        return request

    async def approve_pairing(
        self,
        pairing_code: str,
        user_id: str,
        permissions: list[str] | None = None,
        is_admin: bool = False,
    ) -> bool:
        request = self.pairing_requests.get(pairing_code)
        if not request:
            return False

        if request["expires_at"] < datetime.now():
            await self._expire_pairing(pairing_code, request)
            return False

        resolved_perms = (
            permissions if permissions is not None else self._default_device_permissions
        )

        request["status"] = "approved"
        request["approved_by"] = user_id
        request["granted_permissions"] = resolved_perms
        request["granted_is_admin"] = is_admin
        log_info(f"Pairing code {pairing_code} approved by user {user_id}")
        await self._publish_pairing_lifecycle_event(
            AuthMethods.PAIRING_APPROVED,
            pairing_code,
            request,
            actor_principal_id=user_id,
        )
        await self._audit_pairing_lifecycle(
            "auth.pairing.approved",
            pairing_code,
            request,
            actor_principal_id=user_id,
        )

        # ── Sync to mesh_peers if this pairing is from a mesh peer ──
        remote_peer_id = request.get("remote_peer_id", "")
        if remote_peer_id:
            import json as _json

            try:
                await self._db_request(
                    DBMethods.EXECUTE_SQL,
                    _MeshSQL.approve_peer(
                        remote_peer_id,
                        _json.dumps(resolved_perms),
                        user_id,
                    ),
                )
                log_info(f"Synced pairing approval to mesh_peers for peer {remote_peer_id}")
            except Exception as e:
                log_warning(f"Failed to sync pairing approval to mesh_peers: {e}")

        return True

    async def deny_pairing(
        self,
        pairing_code: str,
        user_id: str,
        reason: str = "",
    ) -> bool:
        request = self.pairing_requests.get(pairing_code)
        if not request:
            return False

        if request["expires_at"] < datetime.now():
            await self._expire_pairing(pairing_code, request)
            return False

        request["status"] = "denied"
        request["denied_by"] = user_id
        request["denied_reason"] = reason
        await self._publish_pairing_lifecycle_event(
            AuthMethods.PAIRING_DENIED,
            pairing_code,
            request,
            actor_principal_id=user_id,
            reason=reason,
        )
        await self._audit_pairing_lifecycle(
            "auth.pairing.denied",
            pairing_code,
            request,
            actor_principal_id=user_id,
            reason=reason,
        )
        log_info(f"Pairing code {pairing_code} denied by user {user_id}")
        return True

    async def exchange_pairing(self, pairing_code: str) -> dict[str, Any] | None:
        request = self.pairing_requests.get(pairing_code)
        if not request or request["status"] != "approved":
            return None

        if request["expires_at"] < datetime.now():
            await self._expire_pairing(pairing_code, request)
            return None

        granted_perms: list[str] = request.get("granted_permissions", [])
        granted_is_admin: bool = request.get("granted_is_admin", False)

        device_username = f"device_{request['device_name']}_{uuid.uuid4().hex[:6]}"
        device_user = User(
            id=str(uuid.uuid4()),
            username=device_username,
            password_hash="DEVICE_NO_PASSWORD",
            role="admin" if granted_is_admin else "device",
            permissions=granted_perms,
            is_admin=granted_is_admin,
        )
        await self._create_user(device_user)

        device_id = str(uuid.uuid4())
        device = Device(
            id=device_id,
            user_id=device_user.id,
            name=request["device_name"],
            is_trusted=True,
        )
        await self._create_device(device)

        token_str = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token_str.encode()).hexdigest()
        token_id = str(uuid.uuid4())

        token_scopes = ["*"] if granted_is_admin else granted_perms

        token = Token(
            id=token_id,
            token_hash=token_hash,
            prefix=token_str[:8],
            device_id=device_id,
            user_id=device_user.id,
            scopes=token_scopes,
            expires_at=datetime.now() + timedelta(days=365),
        )
        await self._create_token(token)

        # ── Link outbound FKs to mesh_peers if from a mesh peer ──
        remote_peer_id = request.get("remote_peer_id", "")
        if remote_peer_id:
            try:
                await self._db_request(
                    DBMethods.EXECUTE_SQL,
                    _MeshSQL.link_outbound_fks(
                        remote_peer_id,
                        token_id,
                        device_id,
                        device_user.id,
                    ),
                )
                log_info(
                    f"Linked outbound FKs to mesh_peers for peer {remote_peer_id}: "
                    f"token={token_id}, device={device_id}, user={device_user.id}"
                )
            except Exception as e:
                log_warning(f"Failed to link outbound FKs to mesh_peers: {e}")

        await self._publish_pairing_lifecycle_event(
            AuthMethods.PAIRING_EXCHANGED,
            pairing_code,
            request,
            actor_principal_id=request.get("approved_by"),
        )
        await self._audit_pairing_lifecycle(
            "auth.pairing.exchanged",
            pairing_code,
            request,
            actor_principal_id=request.get("approved_by"),
        )

        del self.pairing_requests[pairing_code]
        if request["client_ip"] in self.pairing_attempts:
            del self.pairing_attempts[request["client_ip"]]

        # Include our stable mesh peer_id so the initiator can key
        # the saved credential by stable ID (not the transient signaling ID).
        local_peer_id = ""
        local_node_name = ""
        try:
            identity = await self.load_mesh_identity()
            local_peer_id = identity.get("peer_id", "") or ""
            local_node_name = identity.get("node_name", "") or ""
        except Exception:
            pass  # Non-fatal — initiator falls back to signaling ID

        return {
            "token": token_str,
            "device_id": device_id,
            "user_id": device_user.id,
            "permissions": granted_perms,
            "token_id": token_id,
            "peer_id": local_peer_id,
            "node_name": local_node_name,
        }

    def _pending_pairing_entry(self, pairing_code: str, request: dict[str, Any]) -> dict[str, Any]:
        expires_at = request.get("expires_at")
        created_at = request.get("created_at")
        return {
            "request_id": request.get("id", ""),
            "code": pairing_code,
            "device_name": request.get("device_name", ""),
            "client_ip": request.get("client_ip", ""),
            "status": request.get("status", ""),
            "created_at": created_at.isoformat() if isinstance(created_at, datetime) else "",
            "expires_at": expires_at.isoformat() if isinstance(expires_at, datetime) else "",
            "remote_peer_id": request.get("remote_peer_id", ""),
            "remote_node_name": request.get("remote_node_name", ""),
            "approved_by": request.get("approved_by"),
            "denied_by": request.get("denied_by"),
            "denied_reason": request.get("denied_reason", ""),
            "granted_permissions": request.get("granted_permissions", []),
            "granted_is_admin": request.get("granted_is_admin", False),
        }

    async def _prune_expired_pairings(self) -> int:
        now = datetime.now()
        expired = [
            (code, request)
            for code, request in list(self.pairing_requests.items())
            if request.get("expires_at") and request["expires_at"] < now
        ]
        for code, request in expired:
            await self._expire_pairing(code, request)
        return len(expired)

    async def _expire_pairing(self, pairing_code: str, request: dict[str, Any]) -> None:
        await self._publish_pairing_lifecycle_event(
            AuthMethods.PAIRING_EXPIRED,
            pairing_code,
            request,
        )
        await self._audit_pairing_lifecycle(
            "auth.pairing.expired",
            pairing_code,
            request,
        )
        self.pairing_requests.pop(pairing_code, None)

    async def _publish_pairing_lifecycle_event(
        self,
        topic: str,
        pairing_code: str,
        request: dict[str, Any],
        actor_principal_id: str | None = None,
        reason: str = "",
    ) -> None:
        try:
            digest = hashlib.sha256(pairing_code.encode()).hexdigest()
            event = PairingLifecycleEvent(
                request_id=request.get("id", ""),
                event_type=topic.split(".", 1)[1] if "." in topic else topic,
                status=request.get("status", ""),
                code_sha256=digest,
                remote_peer_id=request.get("remote_peer_id", ""),
                remote_node_name=request.get("remote_node_name", ""),
                device_name=request.get("device_name", ""),
                client_ip=request.get("client_ip", ""),
                expires_at=request["expires_at"].isoformat()
                if isinstance(request.get("expires_at"), datetime)
                else "",
                actor_principal_id=actor_principal_id,
                reason=reason,
            )
            await self.bus.publish(topic, event, event=True, origin="internal")
        except Exception as e:
            log_warning(f"Failed to publish pairing lifecycle event {topic}: {e}")

    async def _audit_pairing_lifecycle(
        self,
        event: str,
        pairing_code: str,
        request: dict[str, Any],
        actor_principal_id: str | None = None,
        reason: str = "",
    ) -> None:
        try:
            digest = hashlib.sha256(pairing_code.encode()).hexdigest()
            details = {
                "request_id": request.get("id", ""),
                "code_sha256": digest,
                "device_name": request.get("device_name", ""),
                "client_ip": request.get("client_ip", ""),
                "status": request.get("status", ""),
                "remote_peer_id": request.get("remote_peer_id", ""),
                "remote_node_name": request.get("remote_node_name", ""),
                "reason": reason,
                "secrets_redacted": True,
            }
            from app.shared.contracts.models.auth import StoreAuditEventRequest

            await self.bus.request(
                AuthMethods.STORE_AUDIT_EVENT,
                StoreAuditEventRequest(
                    event=event,
                    principal_id=actor_principal_id,
                    details=json.dumps(details, sort_keys=True),
                    ip_address=request.get("client_ip", ""),
                ),
                timeout=5.0,
            )
        except Exception as e:
            log_warning(f"Failed to audit pairing lifecycle event {event}: {e}")

    def update_permission_defaults(self, default_perms: list[str]) -> None:
        self._default_device_permissions = list(default_perms)

    # ── Identity builders ────────────────────────────────────────────────

    async def build_identity_from_token(
        self, token: Token, source: str = "http_bearer"
    ) -> Identity:
        user = await self._get_user_by_id(token.user_id) if token.user_id else None
        if user is None:
            return build_identity(
                user_id=token.user_id or "unknown",
                username="unknown",
                user_permissions=[],
                user_is_admin=False,
                token_scopes=token.scopes or [],
                device_id=token.device_id,
                source=source,
            )

        return build_identity(
            user_id=user.id,
            username=user.username,
            user_permissions=user.permissions or [],
            user_is_admin=user.is_admin,
            token_scopes=token.scopes or [],
            device_id=token.device_id,
            source=source,
        )

    def build_identity_for_api_key(self) -> Identity:
        return SYSTEM

    # ── Principal CRUD ───────────────────────────────────────────────────

    async def create_principal(
        self,
        username: str,
        password: str | None = None,
        permissions: list[str] | None = None,
        is_admin: bool = False,
    ) -> User | None:
        password_hash = pwd_context.hash(password) if password else "NO_PASSWORD"
        user = User(
            id=str(uuid.uuid4()),
            username=username,
            password_hash=password_hash,
            role="admin" if is_admin else "user",
            permissions=permissions or [],
            is_admin=is_admin,
        )
        success = await self._create_user(user)
        return user if success else None

    async def list_principals(self) -> list[User]:
        return await self._list_users()

    async def get_principal(self, user_id: str) -> User | None:
        return await self._get_user_by_id(user_id)

    async def update_principal(self, user_id: str, **fields: Any) -> User | None:
        if "password" in fields:
            fields["password_hash"] = pwd_context.hash(fields.pop("password"))
        success = await self._update_user(user_id, **fields)
        if success:
            return await self._get_user_by_id(user_id)
        return None

    async def delete_principal(self, user_id: str) -> bool:
        return await self._delete_user(user_id)

    async def set_permissions(self, user_id: str, permissions: list[str]) -> bool:
        return await self._update_user(user_id, permissions=permissions)

    async def patch_permissions(
        self, user_id: str, grant: list[str] | None = None, revoke: list[str] | None = None
    ) -> bool:
        user = await self._get_user_by_id(user_id)
        if not user:
            return False
        current = set(user.permissions or [])
        if grant:
            current.update(grant)
        if revoke:
            current -= set(revoke)
        return await self._update_user(user_id, permissions=list(current))

    async def change_password(self, user_id: str, old_password: str, new_password: str) -> bool:
        user = await self._get_user_by_id(user_id)
        if not user:
            return False
        if not pwd_context.verify(old_password, user.password_hash):
            return False
        return await self._update_user(user_id, password_hash=pwd_context.hash(new_password))

    # ── Token CRUD ───────────────────────────────────────────────────────

    async def create_token_for_principal(
        self,
        principal_id: str,
        device_id: str | None = None,
        scopes: list[str] | None = None,
        expires_in_days: int = 365,
    ) -> tuple[Token, str] | None:
        user = await self._get_user_by_id(principal_id)
        if not user:
            return None

        resolved_scopes = scopes if scopes is not None else ["*"]
        self._validate_scopes_subset(resolved_scopes, user)

        token_str = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token_str.encode()).hexdigest()
        token = Token(
            id=str(uuid.uuid4()),
            token_hash=token_hash,
            prefix=token_str[:8],
            device_id=device_id,
            user_id=principal_id,
            scopes=resolved_scopes,
            expires_at=datetime.now() + timedelta(days=expires_in_days),
        )
        success = await self._create_token(token)
        return (token, token_str) if success else None

    async def list_tokens(
        self, principal_id: str | None = None, device_id: str | None = None
    ) -> list[Token]:
        return await self._list_tokens(user_id=principal_id, device_id=device_id)

    async def update_token_scopes(self, token_id: str, scopes: list[str]) -> bool:
        token = await self._get_token_by_id(token_id)
        if not token:
            return False

        if token.user_id:
            user = await self._get_user_by_id(token.user_id)
            if user:
                self._validate_scopes_subset(scopes, user)

        return await self._update_token_scopes(token_id, scopes)

    async def revoke_token(self, token_id: str) -> bool:
        return await self._revoke_token(token_id)

    async def refresh_token(self, token_str: str) -> tuple[Token, str] | None:
        token = await self.authenticate_token(token_str)
        if not token:
            return None

        await self._revoke_token(token.id)

        new_token_str = secrets.token_urlsafe(32)
        new_token_hash = hashlib.sha256(new_token_str.encode()).hexdigest()
        new_token = Token(
            id=str(uuid.uuid4()),
            token_hash=new_token_hash,
            prefix=new_token_str[:8],
            device_id=token.device_id,
            user_id=token.user_id,
            scopes=token.scopes,
            expires_at=datetime.now() + timedelta(days=365),
        )
        success = await self._create_token(new_token)
        return (new_token, new_token_str) if success else None

    @staticmethod
    def _validate_scopes_subset(scopes: list[str], user: User) -> None:
        if user.is_admin:
            return
        if not scopes or scopes == ["*"]:
            if scopes == ["*"] and "*" not in (user.permissions or []):
                return
            return
        user_perms = set(user.permissions or [])
        for scope in scopes:
            if not has_permission(scope, user_perms):
                raise ValueError(
                    f"Scope '{scope}' exceeds principal's permissions: {sorted(user_perms)}"
                )

    async def login(self, username: str, password: str) -> tuple[Token, str, User] | None:
        user = await self.authenticate_user(username, password)
        if not user:
            return None

        result = await self.create_token_for_principal(
            principal_id=user.id,
            scopes=["*"],
            expires_in_days=1,
        )
        if not result:
            return None

        token, token_str = result
        return token, token_str, user

    # ── Device management ────────────────────────────────────────────────

    async def list_devices(self, principal_id: str | None = None) -> list[Device]:
        return await self._list_devices(user_id=principal_id)

    async def delete_device(self, device_id: str) -> bool:
        return await self._delete_device(device_id)

    # ── Audit ────────────────────────────────────────────────────────────

    async def get_audit_log(
        self,
        limit: int = 50,
        offset: int = 0,
        principal_id: str | None = None,
        event: str | None = None,
        correlation_id: str | None = None,
        peer_id: str | None = None,
        provider_id: str | None = None,
        tool_id: str | None = None,
        action: str | None = None,
        policy_decision_id: str | None = None,
        route: str | None = None,
    ) -> tuple[list[dict[str, Any]], int]:
        if any((correlation_id, peer_id, provider_id, tool_id, action, policy_decision_id, route)):
            # Diagnostic mesh trace view: audit details are JSON strings stored in
            # the audit_log table, so filter after retrieving a bounded window.
            events = await self._get_audit_log(
                limit=max(limit + offset, 1000),
                offset=0,
                principal_id=principal_id,
                event=event,
            )
            filtered = [
                audit_event
                for audit_event in events
                if _audit_event_matches_trace(
                    audit_event,
                    correlation_id=correlation_id,
                    peer_id=peer_id,
                    provider_id=provider_id,
                    tool_id=tool_id,
                    action=action,
                    policy_decision_id=policy_decision_id,
                    route=route,
                )
            ]
            return filtered[offset : offset + limit], len(filtered)

        events = await self._get_audit_log(
            limit=limit, offset=offset, principal_id=principal_id, event=event
        )
        total = await self._count_audit_events(principal_id=principal_id, event=event)
        return events, total

    # ── Mesh credential persistence ──────────────────────────────────────

    async def save_mesh_credential(
        self,
        room_name: str,
        token: str,
        remote_device_id: str | None = None,
        remote_user_id: str | None = None,
    ) -> bool:
        credential = MeshCredential(
            id=str(uuid.uuid4()),
            room_name=room_name,
            token=token,
            remote_device_id=remote_device_id,
            remote_user_id=remote_user_id,
        )
        success = await self._save_mesh_credential(credential)
        if success:
            log_info(f"Saved mesh credential for room '{room_name}'")
        return success

    async def load_mesh_credential(self, room_name: str) -> str | None:
        credential = await self._get_mesh_credential_by_room(room_name)
        return credential.token if credential else None

    async def delete_mesh_credential(self, room_name: str) -> bool:
        return await self._delete_mesh_credential(room_name)

    # ── Mesh Identity (stable peer_id) ───────────────────────────────────

    async def load_mesh_identity(self) -> dict[str, Any]:
        """Load this instance's stable mesh identity from DB.

        Returns:
            dict with ``peer_id`` and ``node_name``, or empty values if not set.
        """
        data = await self._db_request(
            DBMethods.EXECUTE_SQL,
            _MeshSQL.load_identity(),
        )
        if data and data.get("rows"):
            row = data["rows"][0]
            return {"peer_id": row.get("peer_id"), "node_name": row.get("node_name", "")}
        return {"peer_id": None, "node_name": ""}

    async def save_mesh_identity(self, peer_id: str, node_name: str = "") -> None:
        """Save (or update) this instance's stable mesh identity to DB."""
        await self._db_request(
            DBMethods.EXECUTE_SQL,
            _MeshSQL.save_identity(peer_id, node_name),
        )
        log_info(f"Saved mesh identity: peer_id={peer_id}, node_name={node_name}")

    # ── Mesh Peers CRUD ──────────────────────────────────────────────────

    async def upsert_mesh_peer(
        self,
        peer_id: str,
        room_name: str,
        node_name: str = "",
        ip: str | None = None,
        port: int | None = None,
    ) -> str:
        """Create or update a mesh_peers row on peer discovery. Returns row id."""
        import json as _json

        row_id = str(uuid.uuid4())
        await self._db_request(
            DBMethods.EXECUTE_SQL,
            _MeshSQL.upsert_peer(row_id, peer_id, room_name, node_name, ip, port),
        )
        return row_id

    async def list_mesh_peers(
        self,
        room_name: str | None = None,
        outbound_status: str | None = None,
        include_disconnected: bool = True,
    ) -> list[dict[str, Any]]:
        """List all known mesh peers with optional filters."""
        data = await self._db_request(
            DBMethods.EXECUTE_SQL,
            _MeshSQL.list_peers(room_name, outbound_status, include_disconnected),
        )
        return data.get("rows", []) if data else []

    async def get_mesh_peer(
        self, peer_id: str, room_name: str | None = None
    ) -> dict[str, Any] | None:
        """Get a single mesh peer by peer_id."""
        data = await self._db_request(
            DBMethods.EXECUTE_SQL,
            _MeshSQL.get_peer(peer_id, room_name),
        )
        rows = data.get("rows", []) if data else []
        return rows[0] if rows else None

    async def approve_mesh_peer(
        self,
        peer_id: str,
        permissions: list[str],
        approved_by: str | None = None,
    ) -> bool:
        """Approve a mesh peer: update mesh_peers table AND approve any pending pairing code.

        This is the canonical admin action. It:
        1. Sets mesh_peers.outbound_status = 'approved' with permissions
        2. Finds any in-memory pairing code linked to this peer_id and approves it
        3. If the peer already has an outbound principal, updates its permissions too

        Returns True if the mesh_peers row was updated.
        """
        import json as _json

        data = await self._db_request(
            DBMethods.EXECUTE_SQL,
            _MeshSQL.approve_peer(peer_id, _json.dumps(permissions), approved_by),
        )
        updated = bool(data and data.get("rowcount", 0) > 0)

        if updated:
            # ── Also approve any pending pairing code for this peer ──
            for code, req in list(self.pairing_requests.items()):
                if (
                    req.get("remote_peer_id") == peer_id
                    and req.get("status") == "pending"
                    and req.get("expires_at", datetime.min) > datetime.now()
                ):
                    req["status"] = "approved"
                    req["approved_by"] = approved_by
                    req["granted_permissions"] = permissions
                    req["granted_is_admin"] = "*" in permissions
                    log_info(
                        f"MeshApprovePeer also approved pairing code {code} for peer {peer_id}"
                    )
                    break  # At most one active code per peer

            # ── Sync permissions to the existing auth principal if one exists ──
            peer_row = await self.get_mesh_peer(peer_id)
            if peer_row and peer_row.get("outbound_user_id"):
                user_id = peer_row["outbound_user_id"]
                await self._update_user(user_id, permissions=permissions)
                token_id = peer_row.get("outbound_token_id")
                if token_id:
                    token_scopes = ["*"] if "*" in permissions else permissions
                    await self._update_token_scopes(token_id, token_scopes)
                log_info(f"Synced permissions to auth principal {user_id} for mesh peer {peer_id}")

        return updated

    async def deny_mesh_peer(self, peer_id: str) -> bool:
        """Set outbound_status=denied."""
        data = await self._db_request(
            DBMethods.EXECUTE_SQL,
            _MeshSQL.deny_peer(peer_id),
        )
        return bool(data and data.get("rowcount", 0) > 0)

    async def update_mesh_peer_permissions(self, peer_id: str, permissions: list[str]) -> bool:
        """Update outbound permissions for an already-approved peer.

        Consolidation: also syncs to User.permissions and Token.scopes
        for the auth principal associated with this peer.
        """
        import json as _json

        data = await self._db_request(
            DBMethods.EXECUTE_SQL,
            _MeshSQL.update_peer_permissions(peer_id, _json.dumps(permissions)),
        )
        updated = bool(data and data.get("rowcount", 0) > 0)

        if updated:
            # ── Sync permissions to the auth principal ──
            peer_row = await self.get_mesh_peer(peer_id)
            if peer_row and peer_row.get("outbound_user_id"):
                user_id = peer_row["outbound_user_id"]
                await self._update_user(user_id, permissions=permissions)
                token_id = peer_row.get("outbound_token_id")
                if token_id:
                    token_scopes = ["*"] if "*" in permissions else permissions
                    await self._update_token_scopes(token_id, token_scopes)
                log_info(f"Synced permissions to auth principal {user_id} for mesh peer {peer_id}")

        return updated

    async def remove_mesh_peer(self, peer_id: str) -> bool:
        """Delete a mesh peer record entirely."""
        data = await self._db_request(
            DBMethods.EXECUTE_SQL,
            _MeshSQL.remove_peer(peer_id),
        )
        return bool(data and data.get("rowcount", 0) > 0)

    async def save_inbound_credential(
        self,
        remote_peer_id: str,
        room_name: str,
        token: str,
        permissions: list[str] | None = None,
        remote_device_id: str | None = None,
        remote_user_id: str | None = None,
        remote_node_name: str | None = None,
    ) -> None:
        """Save the token a remote peer issued to us (inbound side).

        Tokens are encrypted at rest using the gateway token secret.
        """
        import json as _json

        key = await self._aget_mesh_inbound_key()
        encrypted_token = seal_str(key, token)
        perms_json = _json.dumps(permissions or [])
        await self._db_request(
            DBMethods.EXECUTE_SQL,
            _MeshSQL.save_inbound_credential(
                remote_peer_id,
                room_name,
                encrypted_token,
                perms_json,
                remote_device_id,
                remote_user_id,
                remote_node_name,
            ),
        )
        log_info(f"Saved inbound credential from peer {remote_peer_id}")

    async def load_inbound_credentials(
        self, room_name: str, remote_peer_id: str | None = None
    ) -> dict[str, str]:
        """Load inbound tokens for reconnection. Returns {peer_id: token}.

        Decrypts tokens stored with seal_str; passes through legacy plaintext.
        """
        data = await self._db_request(
            DBMethods.EXECUTE_SQL,
            _MeshSQL.load_inbound_credentials(room_name, remote_peer_id),
        )
        rows = data.get("rows", []) if data else []
        key = await self._aget_mesh_inbound_key()
        result: dict[str, str] = {}
        for r in rows:
            raw = r.get("inbound_token")
            if raw:
                result[r["peer_id"]] = open_str(key, raw)
        return result

    async def update_peer_connection_status(self, peer_id: str, status: str) -> None:
        """Update connection_status and last_seen_at."""
        await self._db_request(
            DBMethods.EXECUTE_SQL,
            _MeshSQL.update_connection_status(peer_id, status),
        )


# ── Mesh SQL Helpers ─────────────────────────────────────────────────────
# These build DBExecuteSQLRequest payloads for DBMethods.EXECUTE_SQL.
# Kept in a separate namespace to avoid cluttering AuthManager.


class _MeshSQL:
    """Static helper to build SQL request payloads for mesh operations.

    Each method returns a ``DBExecuteSQLRequest`` sent via
    ``_db_request(DBMethods.EXECUTE_SQL, ...)``.
    """

    @staticmethod
    def load_identity() -> DBExecuteSQLRequest:
        return DBExecuteSQLRequest(
            sql="SELECT peer_id, node_name FROM mesh_identity WHERE key = 'self'",
            params=[],
        )

    @staticmethod
    def save_identity(peer_id: str, node_name: str) -> DBExecuteSQLRequest:
        return DBExecuteSQLRequest(
            sql=(
                "INSERT INTO mesh_identity (key, peer_id, node_name) "
                "VALUES ('self', ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET peer_id = ?, node_name = ?"
            ),
            params=[peer_id, node_name, peer_id, node_name],
        )

    @staticmethod
    def upsert_peer(
        row_id: str,
        peer_id: str,
        room_name: str,
        node_name: str,
        ip: str | None,
        port: int | None,
    ) -> DBExecuteSQLRequest:
        return DBExecuteSQLRequest(
            sql=(
                "INSERT INTO mesh_peers (id, peer_id, room_name, node_name, ip, port) "
                "VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(peer_id, room_name) DO UPDATE SET "
                "  node_name = COALESCE(NULLIF(excluded.node_name, ''), mesh_peers.node_name), "
                "  ip = COALESCE(excluded.ip, mesh_peers.ip), "
                "  port = COALESCE(excluded.port, mesh_peers.port), "
                "  last_seen_at = CURRENT_TIMESTAMP, "
                "  updated_at = CURRENT_TIMESTAMP"
            ),
            params=[row_id, peer_id, room_name, node_name, ip, port],
        )

    @staticmethod
    def list_peers(
        room_name: str | None,
        outbound_status: str | None,
        include_disconnected: bool,
    ) -> DBExecuteSQLRequest:
        query = "SELECT * FROM mesh_peers WHERE 1=1"
        params: list[Any] = []
        if room_name:
            query += " AND room_name = ?"
            params.append(room_name)
        if outbound_status:
            query += " AND outbound_status = ?"
            params.append(outbound_status)
        if not include_disconnected:
            query += " AND connection_status = 'connected'"
        query += " ORDER BY last_seen_at DESC"
        return DBExecuteSQLRequest(sql=query, params=params)

    @staticmethod
    def get_peer(peer_id: str, room_name: str | None) -> DBExecuteSQLRequest:
        if room_name:
            return DBExecuteSQLRequest(
                sql="SELECT * FROM mesh_peers WHERE peer_id = ? AND room_name = ?",
                params=[peer_id, room_name],
            )
        return DBExecuteSQLRequest(
            sql="SELECT * FROM mesh_peers WHERE peer_id = ? ORDER BY last_seen_at DESC LIMIT 1",
            params=[peer_id],
        )

    @staticmethod
    def approve_peer(
        peer_id: str, permissions_json: str, approved_by: str | None
    ) -> DBExecuteSQLRequest:
        return DBExecuteSQLRequest(
            sql=(
                "UPDATE mesh_peers SET "
                "  outbound_status = 'approved', "
                "  outbound_permissions = ?, "
                "  outbound_approved_at = CURRENT_TIMESTAMP, "
                "  outbound_approved_by = ?, "
                "  last_status_change_at = CURRENT_TIMESTAMP, "
                "  updated_at = CURRENT_TIMESTAMP "
                "WHERE peer_id = ?"
            ),
            params=[permissions_json, approved_by, peer_id],
        )

    @staticmethod
    def deny_peer(peer_id: str) -> DBExecuteSQLRequest:
        return DBExecuteSQLRequest(
            sql=(
                "UPDATE mesh_peers SET "
                "  outbound_status = 'denied', "
                "  last_status_change_at = CURRENT_TIMESTAMP, "
                "  updated_at = CURRENT_TIMESTAMP "
                "WHERE peer_id = ?"
            ),
            params=[peer_id],
        )

    @staticmethod
    def update_peer_permissions(peer_id: str, permissions_json: str) -> DBExecuteSQLRequest:
        return DBExecuteSQLRequest(
            sql=(
                "UPDATE mesh_peers SET "
                "  outbound_permissions = ?, "
                "  updated_at = CURRENT_TIMESTAMP "
                "WHERE peer_id = ? AND outbound_status = 'approved'"
            ),
            params=[permissions_json, peer_id],
        )

    @staticmethod
    def remove_peer(peer_id: str) -> DBExecuteSQLRequest:
        return DBExecuteSQLRequest(
            sql="DELETE FROM mesh_peers WHERE peer_id = ?",
            params=[peer_id],
        )

    @staticmethod
    def save_inbound_credential(
        remote_peer_id: str,
        room_name: str,
        token: str,
        perms_json: str,
        remote_device_id: str | None,
        remote_user_id: str | None,
        remote_node_name: str | None,
    ) -> DBExecuteSQLRequest:
        return DBExecuteSQLRequest(
            sql=(
                "UPDATE mesh_peers SET "
                "  inbound_status = 'approved', "
                "  inbound_token = ?, "
                "  inbound_permissions = ?, "
                "  inbound_device_id = ?, "
                "  inbound_user_id = ?, "
                "  inbound_approved_at = CURRENT_TIMESTAMP, "
                "  node_name = COALESCE(NULLIF(?, ''), node_name), "
                "  last_status_change_at = CURRENT_TIMESTAMP, "
                "  updated_at = CURRENT_TIMESTAMP "
                "WHERE peer_id = ? AND room_name = ?"
            ),
            params=[
                token,
                perms_json,
                remote_device_id,
                remote_user_id,
                remote_node_name,
                remote_peer_id,
                room_name,
            ],
        )

    @staticmethod
    def load_inbound_credentials(room_name: str, remote_peer_id: str | None) -> DBExecuteSQLRequest:
        if remote_peer_id:
            return DBExecuteSQLRequest(
                sql=(
                    "SELECT peer_id, inbound_token FROM mesh_peers "
                    "WHERE room_name = ? AND peer_id = ? AND inbound_token IS NOT NULL"
                ),
                params=[room_name, remote_peer_id],
            )
        return DBExecuteSQLRequest(
            sql=(
                "SELECT peer_id, inbound_token FROM mesh_peers "
                "WHERE room_name = ? AND inbound_token IS NOT NULL"
            ),
            params=[room_name],
        )

    @staticmethod
    def update_connection_status(peer_id: str, status: str) -> DBExecuteSQLRequest:
        return DBExecuteSQLRequest(
            sql=(
                "UPDATE mesh_peers SET "
                "  connection_status = ?, "
                "  last_seen_at = CURRENT_TIMESTAMP, "
                "  updated_at = CURRENT_TIMESTAMP "
                "WHERE peer_id = ?"
            ),
            params=[status, peer_id],
        )

    @staticmethod
    def link_outbound_fks(
        peer_id: str,
        token_id: str,
        device_id: str,
        user_id: str,
    ) -> DBExecuteSQLRequest:
        """Write the outbound principal FKs so mesh_peers links back to auth tables."""
        return DBExecuteSQLRequest(
            sql=(
                "UPDATE mesh_peers SET "
                "  outbound_token_id = ?, "
                "  outbound_device_id = ?, "
                "  outbound_user_id = ?, "
                "  updated_at = CURRENT_TIMESTAMP "
                "WHERE peer_id = ?"
            ),
            params=[token_id, device_id, user_id, peer_id],
        )


def _audit_event_matches_trace(
    audit_event: dict[str, Any],
    *,
    correlation_id: str | None = None,
    peer_id: str | None = None,
    provider_id: str | None = None,
    tool_id: str | None = None,
    action: str | None = None,
    policy_decision_id: str | None = None,
    route: str | None = None,
) -> bool:
    details = audit_event.get("details")
    if isinstance(details, str):
        try:
            details = json.loads(details)
        except json.JSONDecodeError:
            details = {}
    if not isinstance(details, dict):
        details = {}

    filters = {
        "correlation_id": correlation_id,
        "peer_id": peer_id,
        "provider_id": provider_id,
        "tool_id": tool_id,
        "action": action,
        "policy_decision_id": policy_decision_id,
        "route": route,
    }
    for key, expected in filters.items():
        if expected and _detail_value(details, key) != expected:
            return False
    return True


def _detail_value(details: dict[str, Any], key: str) -> str | None:
    value = details.get(key)
    if value is None and key == "peer_id":
        value = details.get("source_peer_id") or details.get("target_peer_id")
    if value is None and key == "tool_id":
        value = details.get("global_tool_id") or details.get("tool_name")
    if value is None and key == "route":
        value = details.get("route_target") or details.get("route")
    return str(value) if value is not None else None
