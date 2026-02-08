"""Authentication middleware for Aurora Gateway.

This module provides optional authentication for the HTTP API:
- API key authentication
- Bearer token authentication
- Permission checking via the ACL Identity model
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from fastapi import HTTPException, Request
from fastapi.security import SecurityScopes

from app.helpers.aurora_logger import log_debug, log_info, log_warning
from app.services.gateway.acl.audit import audit_event
from app.services.gateway.acl.identity import ANONYMOUS, SYSTEM, Identity
from app.services.gateway.auth_service import AuthService
from app.services.gateway.dependencies import get_gateway_auth


def _fire_and_forget(coro: Any) -> None:
    """Schedule a coroutine as a fire-and-forget task.

    The task reference is kept alive via the done callback to prevent
    garbage collection before completion.
    """
    task = asyncio.create_task(coro)
    task.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)


class GatewayAuth:
    """Authentication handler for the gateway.

    Supports:
    - API key authentication via X-API-Key header
    - Bearer token authentication via Authorization header
    - Permission checking via Identity.can()
    - Bypass for health / public endpoints
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
                "/api/auth/login",
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

    async def build_identity_from_token_str(self, token_str: str) -> Identity | None:
        """Authenticate a token and build an Identity.

        Args:
            token_str: The raw token string.

        Returns:
            Identity on success, None on failure.
        """
        if not self._auth_service:
            return None
        token = await self._auth_service.authenticate_token(token_str)
        if not token:
            return None
        return await self._auth_service.build_identity_from_token(token, source="http_bearer")

    def build_identity_for_api_key(self) -> Identity:
        """Build a SYSTEM Identity for API key auth."""
        if self._auth_service:
            return self._auth_service.build_identity_for_api_key()
        return SYSTEM

    def verify_permissions(self, identity: Identity, required_scopes: list[str]) -> bool:
        """Verify that an identity has the required permissions.

        Args:
            identity: The Identity to check.
            required_scopes: List of required permission strings.

        Returns:
            True if all required scopes are satisfied.
        """
        if not required_scopes:
            return True
        return identity.can(*required_scopes)

    def should_bypass(self, path: str) -> bool:
        """Check if a path should bypass authentication.

        Uses exact match or prefix-with-delimiter check to prevent false
        positives (e.g. ``/api/auth/login-debug`` won't match bypass
        ``/api/auth/login``).

        Args:
            path: Request path

        Returns:
            True if path should bypass auth
        """
        return any(
            path == bp or path.startswith(bp + "/")
            for bp in self._bypass_paths
        )

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

    The middleware:
    1. Bypasses configured paths.
    2. Checks API key → produces SYSTEM Identity.
    3. Checks Bearer token → produces resolved Identity.
    4. Attaches Identity to ``request.state.identity``.
    """

    async def auth_middleware(request: Any, call_next: Callable) -> Any:
        """Authentication middleware."""
        from fastapi.responses import JSONResponse

        if not auth.is_enabled() or auth.should_bypass(request.url.path):
            request.state.identity = SYSTEM  # unauthenticated paths get full access
            return await call_next(request)

        # 1. API key
        api_key = request.headers.get("X-API-Key")
        if auth.validate_api_key(api_key):
            request.state.identity = auth.build_identity_for_api_key()
            return await call_next(request)

        # 2. Bearer token
        auth_header = request.headers.get("Authorization")
        if auth_header and auth_header.startswith("Bearer "):
            token_str = auth_header.split(" ", 1)[1]
            identity = await auth.build_identity_from_token_str(token_str)
            if identity:
                request.state.identity = identity
                return await call_next(request)

        log_warning(f"Authentication failed for path: {request.url.path}")

        # Audit: authentication failure
        try:
            from app.services.gateway.dependencies import get_auth_service

            _auth_svc = get_auth_service()
            _fire_and_forget(
                audit_event(
                    _auth_svc.db_manager,
                    "access.denied.auth",
                    principal_id=None,
                    details={"path": request.url.path, "reason": "invalid_or_missing_credentials"},
                    ip_address=request.client.host if request.client else None,
                )
            )
        except Exception:
            pass  # Audit must not break the request flow

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
) -> Identity:
    """FastAPI Security dependency that returns an Identity.

    When auth is disabled, returns SYSTEM. When enabled, resolves the
    Identity from the middleware and checks required scopes.

    Returns:
        Identity for the current request.

    Raises:
        HTTPException 401 if not authenticated.
        HTTPException 403 if insufficient permissions.
    """

    if auth is None:
        auth = get_gateway_auth()

    if not auth.is_enabled():
        return SYSTEM

    if auth.should_bypass(request.url.path):
        return SYSTEM

    # Retrieve identity set by middleware
    identity: Identity | None = getattr(request.state, "identity", None)

    if identity is None:
        # Fallback: re-authenticate (shouldn't happen if middleware is wired)
        auth_header = request.headers.get("Authorization")
        if auth_header and auth_header.startswith("Bearer "):
            token_str = auth_header.split(" ", 1)[1]
            identity = await auth.build_identity_from_token_str(token_str)

    if identity is None:
        api_key = request.headers.get("X-API-Key")
        if auth.validate_api_key(api_key):
            identity = auth.build_identity_for_api_key()

    if identity is None:
        raise HTTPException(status_code=401, detail="Authentication required")

    # Permission check
    if security_scopes.scopes and not identity.can(*security_scopes.scopes):
        log_warning(
            f"Permission denied for {request.url.path}. "
            f"Required: {security_scopes.scopes}, "
            f"Effective: {list(identity.effective_perms)}"
        )

        # Audit: access denied (permission check)
        try:
            from app.services.gateway.dependencies import get_auth_service

            _auth_svc = get_auth_service()
            _fire_and_forget(
                audit_event(
                    _auth_svc.db_manager,
                    "access.denied.permission",
                    principal_id=identity.principal_id,
                    details={
                        "path": request.url.path,
                        "required": security_scopes.scopes,
                        "effective": list(identity.effective_perms),
                    },
                    ip_address=request.client.host if request.client else None,
                )
            )
        except Exception:
            pass  # Audit must not break the request flow

        raise HTTPException(
            status_code=403,
            detail=f"Insufficient permissions. Required scopes: {security_scopes.scopes}",
        )

    return identity
