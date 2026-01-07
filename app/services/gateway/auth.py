"""Authentication middleware for Aurora Gateway.

This module provides optional authentication for the HTTP API:
- API key authentication
- JWT token authentication (placeholder for future)
- Permission checking against method contracts
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from app.helpers.aurora_logger import log_debug, log_warning


class GatewayAuth:
    """Authentication handler for the gateway.

    Supports:
    - API key authentication via X-API-Key header
    - Bypass for health endpoints
    """

    def __init__(
        self,
        enabled: bool = False,
        api_keys: list[str] | None = None,
        bypass_paths: list[str] | None = None,
    ):
        """Initialize authentication handler.

        Args:
            enabled: Whether authentication is enabled
            api_keys: List of valid API keys
            bypass_paths: Paths that don't require authentication
        """
        self._enabled = enabled
        self._api_keys = set(api_keys or [])
        self._bypass_paths = set(bypass_paths or ["/api/health", "/api/docs", "/api/redoc", "/api/openapi.json"])

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
    """Create FastAPI middleware for authentication.

    Args:
        auth: GatewayAuth instance

    Returns:
        Middleware function
    """

    async def auth_middleware(request: Any, call_next: Callable) -> Any:
        """Authentication middleware."""
        from fastapi import HTTPException
        from fastapi.responses import JSONResponse

        # Skip if auth disabled
        if not auth.is_enabled():
            return await call_next(request)

        # Skip bypass paths
        if auth.should_bypass(request.url.path):
            return await call_next(request)

        # Check for API key
        api_key = request.headers.get("X-API-Key")

        if not auth.validate_api_key(api_key):
            log_warning(f"Authentication failed for path: {request.url.path}")
            return JSONResponse(
                status_code=401,
                content={
                    "error": "Invalid or missing API key",
                    "status_code": 401,
                },
                headers={"WWW-Authenticate": "ApiKey"},
            )

        return await call_next(request)

    return auth_middleware

