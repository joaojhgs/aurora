"""Authentication service for Aurora Gateway.

Handles user authentication, token validation, device pairing, and bootstrapping.
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

    async def approve_pairing(self, pairing_code: str, user_id: str) -> bool:
        """Approve a pairing request by a user.

        Args:
            pairing_code: The 6-digit pairing code
            user_id: ID of the user approving the request

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
        log_info(f"Pairing code {pairing_code} approved by user {user_id}")
        return True

    async def exchange_pairing(self, pairing_code: str) -> dict[str, Any] | None:
        """Exchange an approved pairing code for a token.

        Args:
            pairing_code: The 6-digit pairing code

        Returns:
            Dictionary with token, device_id, and user_id if successful, None otherwise
        """
        request = self.pairing_requests.get(pairing_code)
        if not request or request["status"] != "approved":
            return None

        if request["expires_at"] < datetime.now():
            del self.pairing_requests[pairing_code]
            return None

        # Create device
        device_id = str(uuid.uuid4())
        device = Device(
            id=device_id,
            user_id=request["approved_by"],
            name=request["device_name"],
            is_trusted=True,
        )
        await self.db_manager.create_device(device)

        # Create token
        token_str = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token_str.encode()).hexdigest()
        token_id = str(uuid.uuid4())

        token = Token(
            id=token_id,
            token_hash=token_hash,
            prefix=token_str[:8],
            device_id=device_id,
            user_id=request["approved_by"],
            scopes=["all"],  # Default scope
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
            "user_id": request["approved_by"],
        }
