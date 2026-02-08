"""Authentication service for Aurora Gateway.

Handles user authentication, token validation, device pairing, identity building, and bootstrapping.
"""

from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import datetime, timedelta
from typing import Any

from passlib.context import CryptContext

from app.helpers.aurora_logger import log_error, log_info, log_warning
from app.services.db.manager import DatabaseManager
from app.services.db.models import Device, Token, User
from app.services.gateway.acl.identity import SYSTEM, Identity, build_identity
from app.services.gateway.acl.permissions import has_permission

# Password hashing configuration
pwd_context = CryptContext(schemes=["argon2"], deprecated="auto")


class AuthService:
    """Authentication service for Aurora Gateway."""

    def __init__(self, db_path: str | None = None):
        """Initialize Auth service.

        Args:
            db_path: Optional path to database file
        """
        self.db_manager = DatabaseManager(db_path)
        self.pairing_requests: dict[str, dict[str, Any]] = {}
        self.pairing_attempts: dict[str, int] = {}  # Basic rate limiting (IP-based)
        self._default_device_permissions: list[str] = []
        self.login_attempts: dict[str, int] = {}  # IP-based rate limiting for login

    async def initialize(self) -> None:
        """Initialize the auth service and bootstrap if needed."""
        await self.db_manager.initialize()
        await self._bootstrap_admin()
        await self._bootstrap_system_token()

    async def _bootstrap_system_token(self) -> None:
        """Create a system token for internal service use if it doesn't exist."""
        try:
            # Check if system user exists
            system_user = await self.db_manager.get_user_by_username("system")
            if not system_user:
                system_user = User(
                    id="system-user-id",
                    username="system",
                    password_hash="SYSTEM_NO_PASSWORD",
                    role="admin",
                    permissions=["*"],
                    is_admin=True,
                )
                await self.db_manager.create_user(system_user)

            # Check if system device exists
            system_device = await self.db_manager.get_device_by_id("system-device-id")
            if not system_device:
                system_device = Device(
                    id="system-device-id",
                    user_id=system_user.id,
                    name="System Gateway",
                    is_trusted=True,
                )
                await self.db_manager.create_device(system_device)

            # Check if we have a system token
            token_str = "GATEWAY_INTERNAL_TOKEN"
            token_hash = hashlib.sha256(token_str.encode()).hexdigest()
            existing_token = await self.db_manager.get_token_by_hash(token_hash)

            if not existing_token:
                token = Token(
                    id="system-token-id",
                    token_hash=token_hash,
                    prefix=token_str[:8],
                    device_id=system_device.id,
                    user_id=system_user.id,
                    scopes=["all"],
                    expires_at=datetime.now() + timedelta(days=3650),  # 10 years
                )
                await self.db_manager.create_token(token)
                log_info("System token bootstrapped")
        except Exception as e:
            log_error(f"Error bootstrapping system token: {e}")

    async def get_system_token(self) -> str:
        """Get the system token string."""
        return "GATEWAY_INTERNAL_TOKEN"

    async def _bootstrap_admin(self) -> None:
        """Create initial admin user if no users exist."""
        try:
            user_count = await self.db_manager.count_users()
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

                success = await self.db_manager.create_user(admin_user)
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

    async def authenticate_user(self, username: str, password: str) -> User | None:
        """Authenticate a user by username and password.

        Args:
            username: Username
            password: Plain text password

        Returns:
            User object if authenticated, None otherwise
        """
        user = await self.db_manager.get_user_by_username(username)
        if user and pwd_context.verify(password, user.password_hash):
            return user
        return None

    async def authenticate_token(self, token_str: str) -> Token | None:
        """Authenticate a token string.

        Args:
            token_str: The plain text token

        Returns:
            Token object if valid, None otherwise
        """
        token_hash = hashlib.sha256(token_str.encode()).hexdigest()
        token = await self.db_manager.get_token_by_hash(token_hash)

        if token:
            if token.expires_at and token.expires_at < datetime.now():
                # Token expired
                log_warning(f"Token {token.id} has expired")
                await self.db_manager.revoke_token(token.id)
                return None
            return token
        return None

    async def start_pairing(self, device_name: str, client_ip: str) -> str | None:
        """Start a pairing request and return a 6-digit pairing code.

        Args:
            device_name: Name of the device trying to pair
            client_ip: IP address of the client

        Returns:
            6-digit pairing code if successful, None if rate limited
        """
        # Simple rate limiting check
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
            "expires_at": datetime.now() + timedelta(minutes=5),
            "approved_by": None,
        }

        # Increment attempts for rate limiting
        self.pairing_attempts[client_ip] = self.pairing_attempts.get(client_ip, 0) + 1

        log_info(
            f"Pairing started for device '{device_name}' (IP: {client_ip}). Code: {pairing_code}"
        )
        return pairing_code

    async def connect_pairing(self, pairing_code: str) -> dict[str, Any] | None:
        """Check the status of a pairing request.

        Args:
            pairing_code: The 6-digit pairing code

        Returns:
            Pairing request data if valid, None otherwise
        """
        request = self.pairing_requests.get(pairing_code)
        if not request:
            return None

        if request["expires_at"] < datetime.now():
            del self.pairing_requests[pairing_code]
            return None

        return request

    async def approve_pairing(
        self,
        pairing_code: str,
        user_id: str,
        permissions: list[str] | None = None,
        is_admin: bool = False,
    ) -> bool:
        """Approve a pairing request by a user.

        Args:
            pairing_code: The 6-digit pairing code
            user_id: ID of the user approving the request
            permissions: Permissions to grant to the paired device/user.
            is_admin: Whether the paired device gets admin access.

        Returns:
            True if approved, False otherwise
        """
        request = self.pairing_requests.get(pairing_code)
        if not request:
            return False

        if request["expires_at"] < datetime.now():
            del self.pairing_requests[pairing_code]
            return False

        request["status"] = "approved"
        request["approved_by"] = user_id
        request["granted_permissions"] = permissions if permissions is not None else self._default_device_permissions
        request["granted_is_admin"] = is_admin
        log_info(f"Pairing code {pairing_code} approved by user {user_id}")
        return True

    async def exchange_pairing(self, pairing_code: str) -> dict[str, Any] | None:
        """Exchange an approved pairing code for a token.

        Creates a device-principal with the permissions assigned during approval,
        issues a token scoped to those permissions, and returns the credentials.

        Args:
            pairing_code: The 6-digit pairing code

        Returns:
            Dictionary with token, device_id, user_id, and permissions if
            successful, None otherwise.
        """
        request = self.pairing_requests.get(pairing_code)
        if not request or request["status"] != "approved":
            return None

        if request["expires_at"] < datetime.now():
            del self.pairing_requests[pairing_code]
            return None

        granted_perms: list[str] = request.get("granted_permissions", [])
        granted_is_admin: bool = request.get("granted_is_admin", False)

        # Create a device-principal (user record for the device)
        device_username = f"device_{request['device_name']}_{uuid.uuid4().hex[:6]}"
        device_user = User(
            id=str(uuid.uuid4()),
            username=device_username,
            password_hash="DEVICE_NO_PASSWORD",
            role="admin" if granted_is_admin else "device",
            permissions=granted_perms,
            is_admin=granted_is_admin,
        )
        await self.db_manager.create_user(device_user)

        # Create device record
        device_id = str(uuid.uuid4())
        device = Device(
            id=device_id,
            user_id=device_user.id,
            name=request["device_name"],
            is_trusted=True,
        )
        await self.db_manager.create_device(device)

        # Create token scoped to the granted permissions
        token_str = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token_str.encode()).hexdigest()
        token_id = str(uuid.uuid4())

        # Token scopes = granted permissions (or ["*"] if admin)
        token_scopes = ["*"] if granted_is_admin else granted_perms

        token = Token(
            id=token_id,
            token_hash=token_hash,
            prefix=token_str[:8],
            device_id=device_id,
            user_id=device_user.id,
            scopes=token_scopes,
            expires_at=datetime.now() + timedelta(days=365),  # 1 year
        )
        await self.db_manager.create_token(token)

        # Cleanup
        del self.pairing_requests[pairing_code]
        # Reset rate limit on success
        if request["client_ip"] in self.pairing_attempts:
            del self.pairing_attempts[request["client_ip"]]

        return {
            "token": token_str,
            "device_id": device_id,
            "user_id": device_user.id,
            "permissions": granted_perms,
        }

    def update_permission_defaults(self, default_perms: list[str]) -> None:
        """Update the default device permissions from config.

        Args:
            default_perms: Default permission list for newly paired devices.
        """
        self._default_device_permissions = list(default_perms)

    # ── Identity builders ────────────────────────────────────────────────

    async def build_identity_from_token(
        self, token: Token, source: str = "http_bearer"
    ) -> Identity:
        """Build an Identity from a validated Token.

        Loads the associated user and resolves effective permissions.

        Args:
            token: Validated Token object.
            source: How the identity was established.

        Returns:
            Fully resolved Identity.
        """
        user = await self.db_manager.get_user_by_id(token.user_id) if token.user_id else None
        if user is None:
            # Fallback: token exists but user was deleted — treat as no perms
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
        """Build a SYSTEM-like Identity for API key authentication.

        Returns:
            SYSTEM Identity (full access).
        """
        return SYSTEM

    # ── Principal CRUD ───────────────────────────────────────────────────

    async def create_principal(
        self,
        username: str,
        password: str | None = None,
        permissions: list[str] | None = None,
        is_admin: bool = False,
    ) -> User | None:
        """Create a new principal (user or device account).

        Args:
            username: Unique username.
            password: Plain-text password (None for device-only accounts).
            permissions: Permission list (default []).
            is_admin: Admin flag.

        Returns:
            Created User or None on failure.
        """
        password_hash = pwd_context.hash(password) if password else "NO_PASSWORD"
        user = User(
            id=str(uuid.uuid4()),
            username=username,
            password_hash=password_hash,
            role="admin" if is_admin else "user",
            permissions=permissions or [],
            is_admin=is_admin,
        )
        success = await self.db_manager.create_user(user)
        return user if success else None

    async def list_principals(self) -> list[User]:
        """List all principals."""
        return await self.db_manager.list_users()

    async def get_principal(self, user_id: str) -> User | None:
        """Get a principal by ID."""
        return await self.db_manager.get_user_by_id(user_id)

    async def update_principal(self, user_id: str, **fields: Any) -> User | None:
        """Update a principal's fields.

        Supported: username, password (plain text — will be hashed), is_admin.
        """
        if "password" in fields:
            fields["password_hash"] = pwd_context.hash(fields.pop("password"))
        success = await self.db_manager.update_user(user_id, **fields)
        if success:
            return await self.db_manager.get_user_by_id(user_id)
        return None

    async def delete_principal(self, user_id: str) -> bool:
        """Delete a principal (cascades to devices and tokens)."""
        return await self.db_manager.delete_user(user_id)

    async def set_permissions(self, user_id: str, permissions: list[str]) -> bool:
        """Set permissions for a principal (full replace)."""
        return await self.db_manager.update_user(user_id, permissions=permissions)

    async def patch_permissions(
        self, user_id: str, grant: list[str] | None = None, revoke: list[str] | None = None
    ) -> bool:
        """Add/remove specific permissions for a principal."""
        user = await self.db_manager.get_user_by_id(user_id)
        if not user:
            return False
        current = set(user.permissions or [])
        if grant:
            current.update(grant)
        if revoke:
            current -= set(revoke)
        return await self.db_manager.update_user(user_id, permissions=list(current))

    async def change_password(
        self, user_id: str, old_password: str, new_password: str
    ) -> bool:
        """Change a principal's password after verifying the old one."""
        user = await self.db_manager.get_user_by_id(user_id)
        if not user:
            return False
        if not pwd_context.verify(old_password, user.password_hash):
            return False
        return await self.db_manager.update_user(
            user_id, password_hash=pwd_context.hash(new_password)
        )

    # ── Token CRUD ───────────────────────────────────────────────────────

    async def create_token_for_principal(
        self,
        principal_id: str,
        device_id: str | None = None,
        scopes: list[str] | None = None,
        expires_in_days: int = 365,
    ) -> tuple[Token, str] | None:
        """Create a token for a principal. Returns (Token, raw_token_str) or None.

        Raises:
            ValueError: If any scope exceeds the principal's permissions.
        """
        user = await self.db_manager.get_user_by_id(principal_id)
        if not user:
            return None

        resolved_scopes = scopes if scopes is not None else ["*"]

        # Validate that token scopes don't exceed principal permissions
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
        success = await self.db_manager.create_token(token)
        return (token, token_str) if success else None

    async def list_tokens(
        self, principal_id: str | None = None, device_id: str | None = None
    ) -> list[Token]:
        """List tokens, optionally filtered."""
        return await self.db_manager.list_tokens(user_id=principal_id, device_id=device_id)

    async def update_token_scopes(self, token_id: str, scopes: list[str]) -> bool:
        """Update token scopes.

        Raises:
            ValueError: If any scope exceeds the principal's permissions.
        """
        token = await self.db_manager.get_token_by_id(token_id)
        if not token:
            return False

        if token.user_id:
            user = await self.db_manager.get_user_by_id(token.user_id)
            if user:
                self._validate_scopes_subset(scopes, user)

        return await self.db_manager.update_token_scopes(token_id, scopes)

    async def refresh_token(self, token_str: str) -> tuple[Token, str] | None:
        """Refresh a token: revoke old, issue new with same scopes."""
        token = await self.authenticate_token(token_str)
        if not token:
            return None

        # Revoke old
        await self.db_manager.revoke_token(token.id)

        # Issue new
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
        success = await self.db_manager.create_token(new_token)
        return (new_token, new_token_str) if success else None

    @staticmethod
    def _validate_scopes_subset(scopes: list[str], user: User) -> None:
        """Validate that *scopes* are covered by the user's permissions.

        Admins are exempt. Scopes of ``["*"]`` are always allowed for admin
        users but rejected for non-admin users whose permissions don't
        include ``"*"``.

        Raises:
            ValueError: If any scope exceeds the principal's permissions.
        """
        if user.is_admin:
            return  # Admins can have any scopes
        if not scopes or scopes == ["*"]:
            # Wildcard scopes on a non-admin: check if user actually has "*"
            if scopes == ["*"] and "*" not in (user.permissions or []):
                return  # Allowed — effective perms will be the intersection anyway
            return
        user_perms = set(user.permissions or [])
        for scope in scopes:
            if not has_permission(scope, user_perms):
                raise ValueError(
                    f"Scope '{scope}' exceeds principal's permissions: "
                    f"{sorted(user_perms)}"
                )

    async def login(
        self, username: str, password: str
    ) -> tuple[Token, str, User] | None:
        """Authenticate and issue a session token.

        Returns (Token, raw_token_str, User) on success, None on failure.
        """
        user = await self.authenticate_user(username, password)
        if not user:
            return None

        result = await self.create_token_for_principal(
            principal_id=user.id,
            scopes=["*"],  # Session tokens inherit all user perms
            expires_in_days=1,  # Short-lived session token
        )
        if not result:
            return None

        token, token_str = result
        return token, token_str, user
