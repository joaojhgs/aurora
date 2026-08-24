"""Authentication manager for Aurora.

Business logic for user authentication, token management, device pairing,
and credential persistence.  All DB operations go through the message bus
so the Auth service never directly imports from the DB service.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
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
    build_mesh_reconnect_proof_message,
)
from app.shared.contracts.models.db import (
    DBApproveMeshPeerRequest,
    DBAuditLogRequest,
    DBCountAuditEventsRequest,
    DBCountUsersRequest,
    DBCreateDeviceRequest,
    DBCreateTokenRequest,
    DBCreateUserRequest,
    DBDeleteDeviceRequest,
    DBDeleteMeshCredentialRequest,
    DBDeleteUserRequest,
    DBDenyMeshPeerRequest,
    DBExecuteSQLRequest,
    DBGetDeviceByIdRequest,
    DBGetMeshCredentialByRoomRequest,
    DBGetMeshPeerAuthoritySnapshotRequest,
    DBGetTokenByHashRequest,
    DBGetTokenByIdRequest,
    DBGetUserByIdRequest,
    DBGetUserByUsernameRequest,
    DBIssueMeshPeerCredentialRequest,
    DBListDevicesRequest,
    DBListTokensRequest,
    DBListUsersRequest,
    DBMatchMeshOutboundCredentialRequest,
    DBMeshAuthorityChange,
    DBMethods,
    DBRemoveMeshPeerRequest,
    DBRevokeTokenRequest,
    DBSaveMeshCredentialRequest,
    DBSaveMeshInboundCredentialRequest,
    DBUpdateMeshPeerConnectionRequest,
    DBUpdateMeshPeerPermissionsRequest,
    DBUpdateTokenScopesRequest,
    DBUpdateUserRequest,
    DBUpsertMeshPeerRequest,
)
from app.shared.contracts.models.mesh import (
    MeshEvents,
    MeshPeerAuthorityChangedEvent,
    MeshPeerAuthoritySnapshot,
)
from app.shared.crypto import derive_mesh_inbound_key, open_str, seal_str
from app.shared.models.db import Device, MeshCredential, Token, User

# Password hashing configuration
pwd_context = CryptContext(schemes=["argon2"], deprecated="auto")

# DB handlers may legitimately wait through SQLite's 30-second busy window.
# Keep the bus caller alive past that window so timed-out callers do not leave
# duplicate DB work running during startup contention.
AUTH_DB_REQUEST_TIMEOUT_SECONDS = 35.0

# Pairing requests without a transport-authenticated source share one bucket.
# Do not derive this key from PairingStartRequest fields: they are controlled by
# the unauthenticated caller during the pairing bootstrap.
_UNATTRIBUTED_PAIRING_RATE_KEY = "pairing:unattributed"


def _safe_exception_category(exc: Exception) -> str:
    """Return a non-identifying exception category for diagnostics."""

    return type(exc).__name__


class MeshPairingDeniedError(RuntimeError):
    """The exact stable mesh peer was durably denied for this room."""


class AuthManager:
    """Core authentication logic — delegates all DB operations to the bus."""

    def __init__(self, bus: MessageBus) -> None:
        self.bus = bus
        self.pairing_requests: dict[str, dict[str, Any]] = {}
        self.pairing_attempts: dict[str, int] = {}
        # One lock owns the complete in-memory pairing lifecycle. Separate
        # start/exchange locks allowed reconnect supersession or expiry to pop a
        # request while its credential graph was still being committed.
        self._pairing_lifecycle_lock = asyncio.Lock()
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
        if hasattr(secret, "get_secret_value"):
            secret = secret.get_secret_value()
        secret_value = str(secret or "")
        if not secret_value.strip():
            raise RuntimeError("Mesh inbound token secret is unavailable")

        key = derive_mesh_inbound_key(secret_value)
        self._mesh_inbound_key = key
        return key

    # ── Bus helpers ──────────────────────────────────────────────────────

    async def _db_request(
        self,
        topic: str,
        payload: Any,
        timeout: float = AUTH_DB_REQUEST_TIMEOUT_SECONDS,
    ) -> Any:
        """Send a request to the DB service and return result.data or None."""
        result = await self.bus.request(topic, payload, timeout=timeout)
        if result.ok:
            return result.data
        log_error(f"DB request {topic} failed: {result.error}")
        return None

    @staticmethod
    def _authority_changes(data: Any) -> tuple[DBMeshAuthorityChange, ...]:
        """Parse committed DB generations without trusting loose bus payloads."""

        if data is None:
            return ()
        raw_changes = (
            data.get("authority_changes", ())
            if isinstance(data, dict)
            else getattr(data, "authority_changes", ())
        )
        changes: list[DBMeshAuthorityChange] = []
        for raw_change in raw_changes or ():
            try:
                changes.append(DBMeshAuthorityChange.model_validate(raw_change))
            except Exception as exc:
                log_error(f"Ignoring invalid committed mesh authority change: {exc}")
        return tuple(changes)

    async def _publish_authority_changes(self, data: Any) -> None:
        """Publish only revisions returned by an already-committed DB mutation."""

        for change in self._authority_changes(data):
            try:
                await self.bus.publish(
                    MeshEvents.PEER_AUTHORITY_CHANGED,
                    MeshPeerAuthorityChangedEvent.model_validate(change.model_dump()),
                    event=True,
                    origin="internal",
                )
            except Exception as exc:
                log_warning(
                    "Failed to publish committed peer authority revision "
                    f"{change.peer_id}@{change.auth_grant_revision}: {exc}"
                )

    @staticmethod
    def _mutation_succeeded(data: Any, *, operation: str) -> bool:
        """Handle explicit mesh-authority guard failures at the Auth boundary."""

        if isinstance(data, dict):
            error_code = data.get("error_code")
            success = data.get("success")
        else:
            error_code = getattr(data, "error_code", None)
            success = getattr(data, "success", False)
        if error_code == "mesh_managed_authority":
            log_warning(f"Rejected {operation} through generic mesh-managed authority path")
            return False
        return bool(success)

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
        return self._mutation_succeeded(data, operation="user update")

    async def _delete_user(self, user_id: str) -> bool:
        data = await self._db_request(
            DBMethods.DELETE_USER,
            DBDeleteUserRequest(user_id=user_id),
        )
        return self._mutation_succeeded(data, operation="user deletion")

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
        return self._mutation_succeeded(data, operation="device deletion")

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
        return self._mutation_succeeded(data, operation="token creation")

    async def get_mesh_peer_authority_snapshot(
        self,
        peer_id: str | None = None,
    ) -> tuple[MeshPeerAuthoritySnapshot, ...]:
        data = await self._db_request(
            DBMethods.GET_MESH_PEER_AUTHORITY_SNAPSHOT,
            DBGetMeshPeerAuthoritySnapshotRequest(peer_id=peer_id),
        )
        if data is None:
            raise RuntimeError("mesh authority snapshot unavailable")
        if isinstance(data, dict):
            if "authorities" not in data:
                raise RuntimeError("mesh authority snapshot response missing authorities")
            authorities = data["authorities"]
        else:
            if not hasattr(data, "authorities"):
                raise RuntimeError("mesh authority snapshot response missing authorities")
            authorities = data.authorities
        if authorities is None or not isinstance(authorities, (list, tuple)):
            raise RuntimeError("mesh authority snapshot response is malformed")
        return tuple(
            MeshPeerAuthoritySnapshot.model_validate(authority) for authority in authorities
        )

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
        return self._mutation_succeeded(data, operation="token scope update")

    async def _revoke_token(self, token_id: str, *, reject_mesh_linked: bool = False) -> bool:
        data = await self._db_request(
            DBMethods.REVOKE_TOKEN,
            DBRevokeTokenRequest(
                token_id=token_id,
                reject_mesh_linked=reject_mesh_linked,
            ),
        )
        if not self._mutation_succeeded(data, operation="token revocation"):
            return False
        await self._publish_authority_changes(data)
        return True

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

    async def verify_mesh_reconnect_proof(
        self,
        *,
        token_id: str,
        challenge: str,
        proof: str,
        channel_binding: str,
        claimant_peer_id: str,
        verifier_peer_id: str,
        room_name: str,
    ) -> Identity | None:
        """Verify a channel-bound proof without receiving the bearer token.

        The stored token hash is exactly ``SHA256(raw_token)`` and therefore
        serves as the HMAC key shared by issuer and bearer holder. The public
        token ID is accepted only when it is linked to the claimed stable peer
        in this exact mesh room.
        """

        local_identity = await self.load_mesh_identity()
        local_peer_id = str(local_identity.get("peer_id") or "")
        if not local_peer_id or not hmac.compare_digest(local_peer_id, verifier_peer_id):
            return None

        token = await self._get_token_by_id(token_id)
        if token is None:
            return None  # Deleted rows are revoked credentials.

        if token.expires_at:
            now = (
                datetime.now(token.expires_at.tzinfo)
                if token.expires_at.tzinfo is not None
                else datetime.now()
            )
            if token.expires_at < now:
                await self._revoke_token(token.id)
                return None

        linked = await self._mesh_outbound_credential_is_linked(
            token=token,
            claimant_peer_id=claimant_peer_id,
            room_name=room_name,
        )
        if not linked:
            return None

        try:
            key = bytes.fromhex(token.token_hash)
            supplied_proof = bytes.fromhex(proof)
        except ValueError:
            return None
        if (
            len(key) != hashlib.sha256().digest_size
            or len(supplied_proof) != hashlib.sha256().digest_size
        ):
            return None

        message = build_mesh_reconnect_proof_message(
            token_id=token_id,
            challenge=challenge,
            channel_binding=channel_binding,
            claimant_peer_id=claimant_peer_id,
            verifier_peer_id=verifier_peer_id,
            room_name=room_name,
        )
        expected_proof = hmac.digest(key, message, "sha256")
        if not hmac.compare_digest(expected_proof, supplied_proof):
            return None

        return await self.build_identity_from_token(token, source="webrtc_reconnect_proof")

    async def validate_mesh_pairing_token(
        self,
        *,
        token_str: str,
        pairing_session_id: str,
        claimant_peer_id: str,
        room_name: str,
    ) -> Identity | None:
        """Resolve only the bearer minted by one exact bilateral SAS session."""

        async with self._pairing_lifecycle_lock:
            matches = [
                request
                for request in self.pairing_requests.values()
                if request.get("status") == "exchanged"
                and hmac.compare_digest(
                    str(request.get("pairing_session_id") or ""), pairing_session_id
                )
                and hmac.compare_digest(str(request.get("remote_peer_id") or ""), claimant_peer_id)
                and hmac.compare_digest(str(request.get("room_name") or ""), room_name)
            ]
            if len(matches) != 1:
                return None
            exchange_result = matches[0].get("exchange_result")
            if not isinstance(exchange_result, dict):
                return None
            token_id = str(exchange_result.get("token_id") or "")
        if not token_id:
            return None

        token = await self._get_token_by_id(token_id)
        if token is None:
            return None
        if token.expires_at:
            now = (
                datetime.now(token.expires_at.tzinfo)
                if token.expires_at.tzinfo is not None
                else datetime.now()
            )
            if token.expires_at < now:
                await self._revoke_token(token.id)
                return None

        presented_hash = hashlib.sha256(token_str.encode()).hexdigest()
        if not hmac.compare_digest(token.token_hash, presented_hash):
            return None
        if not await self._mesh_outbound_credential_is_linked(
            token=token,
            claimant_peer_id=claimant_peer_id,
            room_name=room_name,
        ):
            return None

        return await self.build_identity_from_token(token, source="webrtc_pairing_session")

    async def _mesh_outbound_credential_is_linked(
        self,
        *,
        token: Token,
        claimant_peer_id: str,
        room_name: str,
    ) -> bool:
        """Require exact token/user/device ownership for one mesh peer row."""

        if not token.user_id or not token.device_id:
            return False
        data = await self._db_request(
            DBMethods.MATCH_MESH_OUTBOUND_CREDENTIAL,
            DBMatchMeshOutboundCredentialRequest(
                token_id=token.id,
                device_id=token.device_id,
                user_id=token.user_id,
                claimant_peer_id=claimant_peer_id,
                room_name=room_name,
            ),
        )
        return bool(
            data
            and (
                data.get("success") is True
                or ("success" not in data and data.get("rowcount", 0) == 1)
            )
        )

    # ── Pairing ──────────────────────────────────────────────────────────

    async def start_pairing(
        self,
        device_name: str,
        client_ip: str,
        remote_peer_id: str = "",
        remote_node_name: str = "",
        room_name: str = "",
        pairing_session_id: str = "",
        verification_code: str = "",
        trusted_rate_limit_key: str | None = None,
        raise_on_denied: bool = False,
    ) -> str | None:
        """Create one idempotent request even under concurrent RPC retries."""
        async with self._pairing_lifecycle_lock:
            return await self._start_pairing_locked(
                device_name,
                client_ip,
                remote_peer_id=remote_peer_id,
                remote_node_name=remote_node_name,
                room_name=room_name,
                pairing_session_id=pairing_session_id,
                verification_code=verification_code,
                trusted_rate_limit_key=trusted_rate_limit_key,
                raise_on_denied=raise_on_denied,
            )

    async def _start_pairing_locked(
        self,
        device_name: str,
        client_ip: str,
        remote_peer_id: str = "",
        remote_node_name: str = "",
        room_name: str = "",
        pairing_session_id: str = "",
        verification_code: str = "",
        trusted_rate_limit_key: str | None = None,
        raise_on_denied: bool = False,
    ) -> str | None:
        # Expired requests no longer consume an active-attempt slot. Prune
        # before enforcing the limit so a peer can retry immediately after one
        # of its prior requests expires.
        await self._prune_expired_pairings()

        now = datetime.now()
        attempt_key = trusted_rate_limit_key or _UNATTRIBUTED_PAIRING_RATE_KEY

        if pairing_session_id:
            if len(pairing_session_id) != 64 or any(
                character not in "0123456789abcdef" for character in pairing_session_id
            ):
                log_warning("Rejected pairing request with invalid session identifier")
                return None
            if len(verification_code) != 8 or not verification_code.isdecimal():
                log_warning("Rejected pairing request with invalid verification code")
                return None
            if not remote_peer_id or not room_name:
                log_warning("Rejected mesh pairing request without stable peer and room linkage")
                return None

            peer_data = await self._db_request(
                DBMethods.EXECUTE_SQL,
                _MeshSQL.get_peer(remote_peer_id, room_name),
            )
            if peer_data is None or not isinstance(peer_data.get("rows"), list):
                log_warning("Could not verify durable mesh peer denial state")
                return None
            peer_rows = peer_data["rows"]
            if peer_rows and peer_rows[0].get("outbound_status") == "denied":
                log_info(f"Refused automatic pairing retry for denied mesh peer {remote_peer_id}")
                if raise_on_denied:
                    raise MeshPairingDeniedError
                return None

            # PairingStart can be retried when an RPC response is lost. Return
            # the same opaque handle only when the entire transport-bound
            # request is identical; conflicting reuse is a protocol error.
            for existing_code, existing in self.pairing_requests.items():
                if existing.get("pairing_session_id") != pairing_session_id:
                    continue
                identical = (
                    existing.get("rate_limit_key") == attempt_key
                    and existing.get("device_name") == device_name
                    and existing.get("remote_peer_id", "") == remote_peer_id
                    and existing.get("remote_node_name", "") == remote_node_name
                    and existing.get("room_name", "") == room_name
                    and existing.get("verification_code", "") == verification_code
                )
                if identical:
                    return existing_code
                log_warning("Rejected conflicting duplicate pairing session")
                return None

            # A reconnect creates a new channel transcript while the user may
            # still be comparing or approving the prior request. Keep that
            # request stable and refresh its transcript binding instead of
            # creating another approval row. If the first side already approved,
            # the approved status and grants must survive the retry.
            if trusted_rate_limit_key:
                for existing_code, existing in self.pairing_requests.items():
                    if (
                        not existing.get("pairing_session_id")
                        or existing.get("status") not in {"pending", "approved"}
                        or existing.get("remote_peer_id") != remote_peer_id
                        or existing.get("room_name") != room_name
                    ):
                        continue
                    previous_key = existing.get("rate_limit_key") or _UNATTRIBUTED_PAIRING_RATE_KEY
                    if previous_key != attempt_key:
                        self._release_pairing_attempt(existing)
                        self.pairing_attempts[attempt_key] = (
                            self.pairing_attempts.get(attempt_key, 0) + 1
                        )
                    existing.update(
                        {
                            "device_name": device_name,
                            "client_ip": client_ip,
                            "rate_limit_key": attempt_key,
                            "remote_node_name": remote_node_name,
                            "pairing_session_id": pairing_session_id,
                            "verification_code": verification_code,
                            "expires_at": now + timedelta(minutes=5),
                        }
                    )
                    return existing_code

            if not await self.upsert_mesh_peer(
                peer_id=remote_peer_id,
                room_name=room_name,
                node_name=remote_node_name,
            ):
                log_warning("Could not establish durable mesh peer row for pairing request")
                return None

        if self.pairing_attempts.get(attempt_key, 0) >= 5:
            log_warning(f"Pairing rate limit exceeded for source: {attempt_key}")
            return None

        # The request handle authorizes status and exchange calls, so it must be
        # high entropy and distinct from the short, display-only verification
        # code. Also avoid overwriting an unrelated live request on collision.
        pairing_code: str | None = None
        for _ in range(10):
            candidate = secrets.token_urlsafe(32)
            if candidate not in self.pairing_requests:
                pairing_code = candidate
                break
        if pairing_code is None:
            log_warning("Could not allocate a unique active pairing code")
            return None

        request_id = str(uuid.uuid4())

        self.pairing_requests[pairing_code] = {
            "id": request_id,
            "device_name": device_name,
            "client_ip": client_ip,
            "rate_limit_key": attempt_key,
            "status": "pending",
            "created_at": now,
            "expires_at": now + timedelta(minutes=5),
            "approved_by": None,
            "remote_peer_id": remote_peer_id,
            "remote_node_name": remote_node_name,
            "room_name": room_name,
            "pairing_session_id": pairing_session_id,
            "verification_code": verification_code
            or "".join(secrets.choice("0123456789") for _ in range(8)),
        }

        self.pairing_attempts[attempt_key] = self.pairing_attempts.get(attempt_key, 0) + 1

        log_info(
            f"Pairing request {request_id} started for device '{device_name}' (IP: {client_ip})"
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
                    expires_at=(now + timedelta(minutes=5)).isoformat(),
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
        async with self._pairing_lifecycle_lock:
            return await self._list_pending_pairings_locked(include_non_pending)

    async def _list_pending_pairings_locked(
        self, include_non_pending: bool
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

    async def connect_pairing(
        self,
        pairing_code: str,
        pairing_session_id: str = "",
        trusted_rate_limit_key: str | None = None,
    ) -> dict[str, Any] | None:
        async with self._pairing_lifecycle_lock:
            return await self._connect_pairing_locked(
                pairing_code,
                pairing_session_id=pairing_session_id,
                trusted_rate_limit_key=trusted_rate_limit_key,
            )

    async def _connect_pairing_locked(
        self,
        pairing_code: str,
        pairing_session_id: str,
        trusted_rate_limit_key: str | None,
    ) -> dict[str, Any] | None:
        request = self.pairing_requests.get(pairing_code)
        if not request:
            return None

        if request["expires_at"] < datetime.now():
            await self._expire_pairing(pairing_code, request)
            return None

        if not self._pairing_transport_matches(
            request,
            pairing_session_id=pairing_session_id,
            trusted_rate_limit_key=trusted_rate_limit_key,
        ):
            return None

        return request

    async def approve_pairing(
        self,
        pairing_code: str,
        user_id: str,
        permissions: list[str] | None = None,
        is_admin: bool = False,
    ) -> bool:
        async with self._pairing_lifecycle_lock:
            return await self._approve_pairing_locked(
                pairing_code,
                user_id,
                permissions=permissions,
                is_admin=is_admin,
            )

    async def _approve_pairing_locked(
        self,
        pairing_code: str,
        user_id: str,
        permissions: list[str] | None,
        is_admin: bool,
    ) -> bool:
        request = self.pairing_requests.get(pairing_code)
        if not request:
            return False

        if request["expires_at"] < datetime.now():
            await self._expire_pairing(pairing_code, request)
            return False
        if request.get("status") != "pending":
            return False

        resolved_perms = list(
            permissions if permissions is not None else self._default_device_permissions
        )
        if is_admin:
            resolved_perms = ["*"]
        elif "*" in resolved_perms:
            log_warning(
                "Refusing pairing approval with wildcard permissions without admin authority"
            )
            return False

        # A SAS-bound mesh approval is durable only when the exact room row and
        # every authority graph already linked to it commit together.
        remote_peer_id = str(request.get("remote_peer_id") or "")
        if remote_peer_id:
            room_name = str(request.get("room_name") or "")
            data = await self._db_request(
                DBMethods.APPROVE_MESH_PEER,
                DBApproveMeshPeerRequest(
                    peer_id=remote_peer_id,
                    permissions=resolved_perms,
                    approved_by=user_id,
                    room_name=room_name,
                ),
            )
            approved_rooms = set(data.get("approved_rooms", [])) if data else set()
            if not data or data.get("success") is not True or room_name not in approved_rooms:
                log_warning("Could not persist mesh pairing approval for exact peer row")
                return False
            await self._publish_authority_changes(data)

        request["status"] = "approved"
        request["approved_by"] = user_id
        request["granted_permissions"] = resolved_perms
        request["granted_is_admin"] = is_admin
        log_info(f"Pairing request {request['id']} approved by user {user_id}")
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

        return True

    async def deny_pairing(
        self,
        pairing_code: str,
        user_id: str,
        reason: str = "",
    ) -> bool:
        async with self._pairing_lifecycle_lock:
            return await self._deny_pairing_locked(pairing_code, user_id, reason=reason)

    async def _deny_pairing_locked(
        self,
        pairing_code: str,
        user_id: str,
        reason: str,
    ) -> bool:
        request = self.pairing_requests.get(pairing_code)
        if not request:
            return False

        if request["expires_at"] < datetime.now():
            await self._expire_pairing(pairing_code, request)
            return False
        if request.get("status") != "pending":
            return False

        if request.get("pairing_session_id"):
            remote_peer_id = str(request.get("remote_peer_id") or "")
            room_name = str(request.get("room_name") or "")
            if not remote_peer_id or not room_name:
                log_warning("Could not persist mesh pairing denial without exact peer linkage")
                return False
            data = await self._db_request(
                DBMethods.DENY_MESH_PEER,
                DBDenyMeshPeerRequest(
                    peer_id=remote_peer_id,
                    room_name=room_name,
                ),
            )
            if not self._mutation_succeeded(data, operation="mesh pairing denial"):
                log_warning("Could not persist mesh pairing denial for exact peer row")
                return False
            await self._publish_authority_changes(data)

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
        log_info(f"Pairing request {request['id']} denied by user {user_id}")
        return True

    async def exchange_pairing(
        self,
        pairing_code: str,
        pairing_session_id: str = "",
        trusted_rate_limit_key: str | None = None,
    ) -> dict[str, Any] | None:
        """Issue at most one credential for concurrent identical exchanges."""
        if pairing_code not in self.pairing_requests:
            return None
        async with self._pairing_lifecycle_lock:
            return await self._exchange_pairing_locked(
                pairing_code,
                pairing_session_id=pairing_session_id,
                trusted_rate_limit_key=trusted_rate_limit_key,
            )

    async def _exchange_pairing_locked(
        self,
        pairing_code: str,
        pairing_session_id: str = "",
        trusted_rate_limit_key: str | None = None,
    ) -> dict[str, Any] | None:
        request = self.pairing_requests.get(pairing_code)
        if not request:
            return None

        if request["expires_at"] < datetime.now():
            await self._expire_pairing(pairing_code, request)
            return None

        if not self._pairing_transport_matches(
            request,
            pairing_session_id=pairing_session_id,
            trusted_rate_limit_key=trusted_rate_limit_key,
        ):
            return None

        # Retrying an identical exchange after a lost RPC response must return
        # the originally issued credential rather than minting another user,
        # device, and token.
        cached_exchange = request.get("exchange_result")
        if isinstance(cached_exchange, dict):
            return dict(cached_exchange)

        if request["status"] != "approved":
            return None

        granted_perms: list[str] = request.get("granted_permissions", [])
        granted_is_admin: bool = request.get("granted_is_admin", False)

        remote_peer_id = str(request.get("remote_peer_id") or "")
        room_name = str(request.get("room_name") or "")
        pending_exchange = request.get("pending_exchange")
        if not isinstance(pending_exchange, dict):
            token_str = secrets.token_urlsafe(32)
            token_scopes = ["*"] if granted_is_admin else granted_perms
            user_id = str(uuid.uuid4())
            device_id = str(uuid.uuid4())
            issued_at = datetime.now().isoformat()
            pending_exchange = {
                "token": token_str,
                "token_hash": hashlib.sha256(token_str.encode()).hexdigest(),
                "token_prefix": token_str[:8],
                "token_id": str(uuid.uuid4()),
                "device_id": device_id,
                "user_id": user_id,
                "username": f"device_{request['device_name']}_{uuid.uuid4().hex[:6]}",
                "permissions": token_scopes,
                "user_permissions": list(granted_perms),
                "is_admin": granted_is_admin,
                "created_at": issued_at,
                "expires_at": (datetime.now() + timedelta(days=365)).isoformat(),
            }
            request["pending_exchange"] = dict(pending_exchange)

        if "created_at" not in pending_exchange:
            pending_exchange["created_at"] = datetime.now().isoformat()
            request["pending_exchange"] = dict(pending_exchange)
        issued_created_at = datetime.fromisoformat(str(pending_exchange["created_at"]))
        device_user = User(
            id=str(pending_exchange["user_id"]),
            username=str(pending_exchange["username"]),
            password_hash="DEVICE_NO_PASSWORD",
            role="admin" if granted_is_admin else "device",
            permissions=list(pending_exchange.get("user_permissions", granted_perms)),
            is_admin=bool(pending_exchange.get("is_admin", granted_is_admin)),
            created_at=issued_created_at,
        )
        device_id = str(pending_exchange["device_id"])
        device = Device(
            id=device_id,
            user_id=device_user.id,
            name=request["device_name"],
            is_trusted=True,
            created_at=issued_created_at,
        )
        token_id = str(pending_exchange["token_id"])
        token = Token(
            id=token_id,
            token_hash=str(pending_exchange["token_hash"]),
            prefix=str(pending_exchange["token_prefix"]),
            device_id=device_id,
            user_id=device_user.id,
            scopes=list(pending_exchange.get("permissions", [])),
            expires_at=datetime.fromisoformat(str(pending_exchange["expires_at"])),
            created_at=issued_created_at,
        )

        if remote_peer_id:
            if not room_name:
                log_error("Approved mesh pairing has no exact room linkage")
                return None
            issue_data = await self._db_request(
                DBMethods.ISSUE_MESH_PEER_CREDENTIAL,
                DBIssueMeshPeerCredentialRequest(
                    peer_id=remote_peer_id,
                    room_name=room_name,
                    user=DBCreateUserRequest(
                        id=device_user.id,
                        username=device_user.username,
                        password_hash=device_user.password_hash,
                        role=device_user.role,
                        permissions=device_user.permissions,
                        is_admin=device_user.is_admin,
                        created_at=device_user.created_at.isoformat()
                        if device_user.created_at
                        else None,
                    ),
                    device=DBCreateDeviceRequest(
                        id=device.id,
                        user_id=device.user_id,
                        name=device.name,
                        public_key=device.public_key,
                        is_trusted=device.is_trusted,
                        created_at=device.created_at.isoformat() if device.created_at else None,
                    ),
                    token=DBCreateTokenRequest(
                        id=token.id,
                        token_hash=token.token_hash,
                        prefix=token.prefix,
                        device_id=token.device_id,
                        user_id=token.user_id,
                        scopes=token.scopes or [],
                        expires_at=token.expires_at.isoformat() if token.expires_at else None,
                        created_at=token.created_at.isoformat() if token.created_at else None,
                    ),
                ),
            )
            if not self._mutation_succeeded(issue_data, operation="mesh credential issue"):
                log_error("Could not atomically issue mesh peer credential")
                return None
            await self._publish_authority_changes(issue_data)
        else:
            if not await self._create_user(device_user):
                log_error("Could not persist the paired device user")
                return None
            if not await self._create_device(device):
                log_error("Could not persist the paired device record")
                await self._delete_user(device_user.id)
                return None
            if not await self._create_token(token):
                log_error("Could not persist the paired device credential")
                await self._delete_device(device_id)
                await self._delete_user(device_user.id)
                return None

        # Include our stable mesh peer_id so the initiator can key
        # the saved credential by stable ID (not the transient signaling ID).
        local_peer_id = ""
        local_node_name = ""
        try:
            identity = await self.load_mesh_identity()
            local_peer_id = identity.get("peer_id", "") or ""
            local_node_name = identity.get("node_name", "") or ""
        except Exception as exc:
            # Non-fatal — initiator falls back to signaling ID.  Keep evidence
            # without logging peer identifiers, node names, tokens, or codes.
            log_warning(
                "PairingExchange mesh identity unavailable; "
                "fallback=signaling_peer_id "
                f"reason={_safe_exception_category(exc)}"
            )

        exchange_result = {
            "token": str(pending_exchange["token"]),
            "device_id": device_id,
            "user_id": device_user.id,
            "permissions": list(pending_exchange.get("permissions", [])),
            "token_id": token_id,
            "peer_id": local_peer_id,
            "node_name": local_node_name,
        }
        request["status"] = "exchanged"
        request["exchange_result"] = dict(exchange_result)
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
        if not request.get("rate_limit_released"):
            self._release_pairing_attempt(request)
            request["rate_limit_released"] = True
        return exchange_result

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
            "pairing_session_id": request.get("pairing_session_id", ""),
            "verification_code": request.get("verification_code", ""),
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
        if request.get("status") != "exchanged":
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
        removed = self.pairing_requests.pop(pairing_code, None)
        if removed is not None and not request.get("rate_limit_released"):
            self._release_pairing_attempt(request)

    @staticmethod
    def _pairing_transport_matches(
        request: dict[str, Any],
        *,
        pairing_session_id: str,
        trusted_rate_limit_key: str | None,
    ) -> bool:
        """Bind mesh-v2 bearer handles to their exact WebRTC transcript.

        Direct manager calls omit ``trusted_rate_limit_key`` and are used by
        trusted in-process administration/tests. External service handlers
        always provide a source key, so a v2 request then requires both the
        matching session identifier and the original transport peer.
        """
        stored_session = str(request.get("pairing_session_id") or "")
        if not stored_session or trusted_rate_limit_key is None:
            return True
        if not pairing_session_id:
            return False
        if not secrets.compare_digest(stored_session, pairing_session_id):
            return False
        stored_source = str(request.get("rate_limit_key") or "")
        if not stored_source:
            return False
        return secrets.compare_digest(stored_source, trusted_rate_limit_key)

    def _release_pairing_attempt(self, request: dict[str, Any]) -> None:
        """Release one active rate-limit slot owned by ``request``."""
        attempt_key = request.get("rate_limit_key", _UNATTRIBUTED_PAIRING_RATE_KEY)
        attempts = self.pairing_attempts.get(attempt_key, 0)
        if attempts <= 1:
            self.pairing_attempts.pop(attempt_key, None)
            return
        self.pairing_attempts[attempt_key] = attempts - 1

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

        # A mesh-linked bearer is part of a stable-peer authority graph. A
        # generic refresh cannot atomically relink its replacement credential,
        # so reject it instead of splitting the graph across transactions.
        if not await self._revoke_token(token.id, reject_mesh_linked=True):
            return None

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
        if data is None or not isinstance(data.get("rows"), list):
            raise RuntimeError("Could not load mesh identity from the database")
        if data["rows"]:
            row = data["rows"][0]
            return {"peer_id": row.get("peer_id"), "node_name": row.get("node_name", "")}
        return {"peer_id": None, "node_name": ""}

    async def save_mesh_identity(self, peer_id: str, node_name: str = "") -> bool:
        """Persist this instance's stable identity and verify the exact DB value."""
        if not peer_id.strip():
            log_error("Refusing to save an empty mesh peer identity")
            return False

        result = await self._db_request(
            DBMethods.EXECUTE_SQL,
            _MeshSQL.save_identity(peer_id, node_name),
        )
        if not result or result.get("rowcount") != 1:
            log_error(f"Failed to persist mesh identity: peer_id={peer_id}")
            return False

        try:
            stored = await self.load_mesh_identity()
        except RuntimeError as exc:
            log_error(f"Failed to verify persisted mesh identity: {exc}")
            return False
        if stored.get("peer_id") != peer_id or stored.get("node_name", "") != node_name:
            log_error(f"Mesh identity read-back did not match: peer_id={peer_id}")
            return False

        log_info(f"Saved mesh identity: peer_id={peer_id}, node_name={node_name}")
        return True

    # ── Mesh Peers CRUD ──────────────────────────────────────────────────

    async def upsert_mesh_peer(
        self,
        peer_id: str,
        room_name: str,
        node_name: str = "",
        ip: str | None = None,
        port: int | None = None,
    ) -> bool:
        """Create or update a mesh peer row and report durable success."""
        row_id = str(uuid.uuid4())
        data = await self._db_request(
            DBMethods.UPSERT_MESH_PEER,
            DBUpsertMeshPeerRequest(
                id=row_id,
                peer_id=peer_id,
                room_name=room_name,
                node_name=node_name,
                ip=ip,
                port=port,
            ),
        )
        if data is None:
            return False
        if "success" in data:
            return bool(data.get("success"))
        if "rowcount" in data:
            return data.get("rowcount") == 1
        return True

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
        """Atomically approve stable-peer trust rows and linked authority graphs.

        This is the canonical admin action. It:
        1. Approves every room row for the stable peer in one DB transaction.
        2. Updates every complete User/Token authority graph already linked.
        3. Advances a pending pairing only when its exact room row committed.

        Returns True only when the complete durable approval committed.
        """
        data = await self._db_request(
            DBMethods.APPROVE_MESH_PEER,
            DBApproveMeshPeerRequest(
                peer_id=peer_id,
                permissions=permissions,
                approved_by=approved_by,
            ),
        )
        if not data or data.get("success") is not True:
            return False
        approved_rooms = {str(room_name) for room_name in data.get("approved_rooms", [])}
        if not approved_rooms:
            return False
        await self._publish_authority_changes(data)
        await self._approve_pending_pairing_for_peer(
            peer_id,
            permissions,
            approved_by,
            approved_rooms=approved_rooms,
        )
        return True

    async def _approve_pending_pairing_for_peer(
        self,
        peer_id: str,
        permissions: list[str],
        approved_by: str | None,
        *,
        approved_rooms: set[str],
    ) -> None:
        """Apply a durable peer approval to at most one live pairing request."""

        async with self._pairing_lifecycle_lock:
            for code, req in list(self.pairing_requests.items()):
                request_room = str(req.get("room_name") or "")
                exact_room_approved = (
                    request_room in approved_rooms if request_room else len(approved_rooms) == 1
                )
                if (
                    req.get("remote_peer_id") == peer_id
                    and req.get("status") == "pending"
                    and req.get("expires_at", datetime.min) > datetime.now()
                    and exact_room_approved
                ):
                    req["status"] = "approved"
                    req["approved_by"] = approved_by
                    req["granted_permissions"] = permissions
                    req["granted_is_admin"] = "*" in permissions
                    log_info(
                        f"MeshApprovePeer also approved pairing code {code} for peer {peer_id}"
                    )
                    break  # At most one active code per peer

    async def deny_mesh_peer(self, peer_id: str) -> bool:
        """Atomically revoke the peer authority graph while retaining its row."""
        data = await self._db_request(
            DBMethods.DENY_MESH_PEER,
            DBDenyMeshPeerRequest(peer_id=peer_id),
        )
        if not self._mutation_succeeded(data, operation="mesh peer denial"):
            return False
        await self._publish_authority_changes(data)
        return True

    async def update_mesh_peer_permissions(self, peer_id: str, permissions: list[str]) -> bool:
        """Update outbound permissions for an already-approved peer.

        The DB service owns the transaction that updates ``mesh_peers``, the
        dedicated ``User``, and its ``Token``.  Returning success from a series
        of independent writes could publish authority that was only partially
        persisted.
        """
        data = await self._db_request(
            DBMethods.UPDATE_MESH_PEER_PERMISSIONS,
            DBUpdateMeshPeerPermissionsRequest(
                peer_id=peer_id,
                permissions=permissions,
            ),
        )
        updated = bool(data and data.get("success") is True)
        if updated:
            await self._publish_authority_changes(data)
            log_info(f"Atomically updated permissions for mesh peer {peer_id}")
        return updated

    async def remove_mesh_peer(self, peer_id: str, *, revoke_token: bool = True) -> bool:
        """Delete a mesh peer and clear its in-memory pairing decisions."""
        data = await self._db_request(
            DBMethods.REMOVE_MESH_PEER,
            DBRemoveMeshPeerRequest(
                peer_id=peer_id,
                revoke_token=revoke_token,
            ),
        )
        if not self._mutation_succeeded(data, operation="mesh peer removal"):
            return False
        await self._publish_authority_changes(data)

        async with self._pairing_lifecycle_lock:
            stale_pairings = [
                (code, request)
                for code, request in self.pairing_requests.items()
                if request.get("remote_peer_id") == peer_id
            ]
            for code, request in stale_pairings:
                self.pairing_requests.pop(code, None)
                if not request.get("rate_limit_released"):
                    self._release_pairing_attempt(request)
        return True

    async def save_inbound_credential(
        self,
        remote_peer_id: str,
        room_name: str,
        token: str,
        token_id: str = "",
        permissions: list[str] | None = None,
        remote_device_id: str | None = None,
        remote_user_id: str | None = None,
        remote_node_name: str | None = None,
    ) -> bool:
        """Save the token a remote peer issued to us (inbound side).

        Tokens are encrypted at rest using the gateway token secret.
        """
        if not await self.upsert_mesh_peer(
            peer_id=remote_peer_id,
            room_name=room_name,
            node_name=remote_node_name or "",
        ):
            return False

        key = await self._aget_mesh_inbound_key()
        encrypted_token = seal_str(key, token)
        data = await self._db_request(
            DBMethods.SAVE_MESH_INBOUND_CREDENTIAL,
            DBSaveMeshInboundCredentialRequest(
                peer_id=remote_peer_id,
                room_name=room_name,
                encrypted_token=encrypted_token,
                token_id=token_id or None,
                permissions=permissions or [],
                remote_device_id=remote_device_id,
                remote_user_id=remote_user_id,
                remote_node_name=remote_node_name,
            ),
        )
        saved = bool(
            data
            and (
                data.get("success") is True or ("success" not in data and data.get("rowcount") == 1)
            )
        )
        if saved:
            log_info(f"Saved inbound credential from peer {remote_peer_id}")
        return saved

    async def load_inbound_credentials(
        self, room_name: str, remote_peer_id: str | None = None
    ) -> dict[str, dict[str, str]]:
        """Load peer-scoped bearer records for reconnect proof generation.

        Decrypts tokens stored with seal_str; passes through legacy plaintext.
        """
        data = await self._db_request(
            DBMethods.EXECUTE_SQL,
            _MeshSQL.load_inbound_credentials(room_name, remote_peer_id),
        )
        if data is None or not isinstance(data.get("rows"), list):
            raise RuntimeError("Could not load inbound mesh credentials from the database")
        rows = data["rows"]
        if not rows:
            return {}
        key = await self._aget_mesh_inbound_key()
        result: dict[str, dict[str, str]] = {}
        for r in rows:
            raw = r.get("inbound_token")
            if raw:
                try:
                    token = open_str(key, raw)
                except ValueError:
                    log_warning(
                        f"Skipping corrupt encrypted inbound credential for peer {r.get('peer_id')}"
                    )
                    continue
                result[r["peer_id"]] = {
                    "token": token,
                    "token_id": str(r.get("inbound_token_id") or ""),
                }
        return result

    async def update_peer_connection_status(self, peer_id: str, status: str) -> None:
        """Update connection_status and last_seen_at."""
        await self._db_request(
            DBMethods.UPDATE_MESH_PEER_CONNECTION,
            DBUpdateMeshPeerConnectionRequest(
                peer_id=peer_id,
                connection_status=status,
            ),
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
    def load_inbound_credentials(room_name: str, remote_peer_id: str | None) -> DBExecuteSQLRequest:
        if remote_peer_id:
            return DBExecuteSQLRequest(
                sql=(
                    "SELECT peer_id, inbound_token, inbound_token_id FROM mesh_peers "
                    "WHERE room_name = ? AND peer_id = ? AND inbound_token IS NOT NULL"
                ),
                params=[room_name, remote_peer_id],
            )
        return DBExecuteSQLRequest(
            sql=(
                "SELECT peer_id, inbound_token, inbound_token_id FROM mesh_peers "
                "WHERE room_name = ? AND inbound_token IS NOT NULL"
            ),
            params=[room_name],
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
