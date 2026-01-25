"""Authentication middleware for Aurora Gateway.

This module provides optional authentication for the HTTP API:
- API key authentication
- JWT token authentication (placeholder for future)
- Permission checking against method contracts
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from fastapi import HTTPException, Request
from fastapi.security import SecurityScopes

from app.helpers.aurora_logger import log_debug, log_info, log_warning
from app.services.gateway.auth_service import AuthService
from app.services.gateway.dependencies import get_gateway_auth


class GatewayAuth:
    """Authentication handler for the gateway.

    Supports:
    - API key authentication via X-API-Key header
    - JWT token authentication via Authorization header
    - Permission checking against method contracts
    - Bypass for health endpoints
    """

    def __init__(
        self,
        auth_service: AuthService | None = None,
        enabled: bool = False,
        api_keys: list[str] | None = None,
        bypass_paths: list[str] | None = None,
    ):
        """Initialize authentication handler.

        Args:
            auth_service: AuthService instance for token validation
            enabled: Whether authentication is enabled
            api_keys: List of valid API keys
            bypass_paths: Paths that don't require authentication
        """
        self._auth_service = auth_service
        self._enabled = enabled
        self._api_keys = set(api_keys or [])
        self._bypass_paths = set(
            bypass_paths
            or [
                "/api/health",
                "/api/docs",
                "/api/redoc",
                "/api/openapi.json",
                "/api/auth/pairing/start",
                "/api/auth/pairing/connect",
                "/api/auth/pairing/exchange",
            ]
        )

    def is_enabled(self) -> bool:
        """Check if authentication is enabled."""
        return self._enabled

    def validate_api_key(self, api_key: str | None) -> bool:
        """Validate an API key.

        Args:
            api_key: The API key to validate

        Returns:
            True if valid, False otherwise
        """
        if not self._enabled:
            return True

        if api_key is None:
            return False

        return api_key in self._api_keys

    async def authenticate_token(self, token_str: str) -> Any | None:
        """Authenticate a token using AuthService.

        Args:
            token_str: The token string to validate

        Returns:
            Token object if valid, None otherwise
        """
        if not self._auth_service:
            return None
        return await self._auth_service.authenticate_token(token_str)

    def verify_permissions(self, token: Any, required_scopes: list[str]) -> bool:
        """Verify that a token has the required permissions."""
        if not token:
            return False

        user_role = getattr(token, "role", None)
        token_scopes = getattr(token, "scopes", [])

        is_admin = user_role == "admin"
        has_root_scope = "*" in token_scopes or "all" in token_scopes

        if is_admin or has_root_scope:
            return True

        return any(scope in token_scopes for scope in required_scopes)

    def should_bypass(self, path: str) -> bool:
        """Check if a path should bypass authentication.

        Args:
            path: Request path

        Returns:
            True if path should bypass auth
        """
        return any(path.startswith(bypass_path) for bypass_path in self._bypass_paths)

    def add_api_key(self, api_key: str) -> None:
        """Add an API key.

        Args:
            api_key: API key to add
        """
        self._api_keys.add(api_key)
        log_debug(f"Added API key (hash: {hash(api_key)})")

    def remove_api_key(self, api_key: str) -> None:
        """Remove an API key.

        Args:
            api_key: API key to remove
        """
        self._api_keys.discard(api_key)

    def set_enabled(self, enabled: bool) -> None:
        """Enable or disable authentication.

        Args:
            enabled: Whether to enable authentication
        """
        self._enabled = enabled
        log_debug(f"Authentication {'enabled' if enabled else 'disabled'}")


def create_auth_middleware(auth: GatewayAuth) -> Callable:
    """Create FastAPI middleware for authentication."""

    async def auth_middleware(request: Any, call_next: Callable) -> Any:
        """Authentication middleware."""
        from fastapi.responses import JSONResponse

        if not auth.is_enabled() or auth.should_bypass(request.url.path):
            return await call_next(request)

        api_key = request.headers.get("X-API-Key")
        if auth.validate_api_key(api_key):
            return await call_next(request)

        auth_header = request.headers.get("Authorization")
        if auth_header and auth_header.startswith("Bearer "):
            token_str = auth_header.split(" ")[1]
            token = await auth.authenticate_token(token_str)
            if token:
                request.state.token = token
                return await call_next(request)

        log_warning(f"Authentication failed for path: {request.url.path}")
        return JSONResponse(
            status_code=401,
            content={
                "error": "Invalid or missing authentication",
                "status_code": 401,
            },
            headers={"WWW-Authenticate": "Bearer, ApiKey"},
        )

    return auth_middleware


async def check_auth_enabled(
    request: Request,
    security_scopes: SecurityScopes,
    auth: Any = None,
) -> Any:
    """Dependency to check if auth is enabled and valid."""

    if auth is None:
        auth = get_gateway_auth()

    if not auth.is_enabled():
        return None

    if auth.should_bypass(request.url.path):
        return None

    token = None
    # Check if token already in state from middleware
    if hasattr(request.state, "token"):
        token = request.state.token
    else:
        # Re-verify if needed (though middleware should have handled it)
        auth_header = request.headers.get("Authorization")
        if auth_header and auth_header.startswith("Bearer "):
            token_str = auth_header.split(" ")[1]
            token = await auth.authenticate_token(token_str)

    # API key check as fallback
    if token is None:
        api_key = request.headers.get("X-API-Key")
        if auth.validate_api_key(api_key):
            token = "api_key"

    if token is None:
        raise HTTPException(status_code=401, detail="Authentication required")

    if (
        security_scopes.scopes
        and token != "api_key"
        and not auth.verify_permissions(token, security_scopes.scopes)
    ):
        log_warning(
            f"Permission denied for {request.url.path}. Required scopes: {security_scopes.scopes}"
        )
        raise HTTPException(
            status_code=403,
            detail=f"Insufficient permissions. Required scopes: {security_scopes.scopes}",
        )

    return token
