"""Authentication middleware for Aurora Gateway.

This module provides optional authentication for the HTTP API:
- API key authentication
- Bearer token authentication
- Permission checking via the ACL Identity model
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from fastapi import HTTPException, Request, Security
from fastapi.security import APIKeyHeader, HTTPAuthorizationCredentials, HTTPBearer, SecurityScopes

from app.helpers.aurora_logger import log_debug, log_info, log_warning
from app.services.gateway.acl.identity import ANONYMOUS, SYSTEM, Identity
from app.services.gateway.dependencies import get_gateway_auth


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
        auth_service: Any = None,
        enabled: bool = False,
        api_keys: list[str] | None = None,
        bypass_paths: list[str] | None = None,
    ):
        """Initialize authentication handler.

        Args:
            auth_service: Auth service or BusAuthProxy for token validation
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
        return any(path == bp or path.startswith(bp + "/") for bp in self._bypass_paths)

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

        if not auth.is_enabled():
            request.state.identity = SYSTEM
            return await call_next(request)

        if auth.should_bypass(request.url.path):
            request.state.identity = ANONYMOUS
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

        return JSONResponse(
            status_code=401,
            content={
                "error": "Invalid or missing authentication",
                "status_code": 401,
            },
            headers={"WWW-Authenticate": "Bearer, ApiKey"},
        )

    return auth_middleware


# ---------------------------------------------------------------------------
# OpenAPI security schemes
# ---------------------------------------------------------------------------
# Declaring these as module-level objects causes FastAPI / Swagger UI to
# render the **Authorize** button with both options.  ``auto_error=False``
# means the dependency itself never raises — the logic below handles 401.
_bearer_scheme = HTTPBearer(auto_error=False)
_apikey_scheme = APIKeyHeader(name="X-API-Key", auto_error=False)


async def check_auth_enabled(
    request: Request,
    security_scopes: SecurityScopes,
    bearer: HTTPAuthorizationCredentials | None = Security(_bearer_scheme),  # noqa: B008
    api_key_header: str | None = Security(_apikey_scheme),  # noqa: B008
    auth: Any = None,
) -> Identity:
    """FastAPI Security dependency that returns an Identity.

    When auth is disabled, returns SYSTEM. When enabled, resolves the
    Identity from the middleware and checks required scopes.

    The ``bearer`` and ``api_key_header`` parameters are declared so that
    FastAPI's OpenAPI generator registers the **Authorize** button in
    Swagger UI.  The actual credential resolution still happens via the
    middleware (``request.state.identity``) with a fallback to direct
    header inspection.

    Returns:
        Identity for the current request.

    Raises:
        HTTPException 401 if not authenticated.
        HTTPException 403 if insufficient permissions.
    """
    return await _resolve_identity_and_check(
        request,
        security_scopes,
        bearer,
        api_key_header,
        auth=auth,
    )


def create_scoped_auth_check(method_type: str = "use"):
    """Factory that creates an auth dependency with ``method_type`` context.

    This allows the permission engine to match type-based permissions
    like ``"Auth.use"`` or ``"TTS.manage"`` against the required bus
    topic scope.

    Args:
        method_type: ``"use"`` or ``"manage"`` — the method's access level.

    Returns:
        An async FastAPI security dependency with the same signature as
        :func:`check_auth_enabled`.
    """

    async def scoped_auth_check(
        request: Request,
        security_scopes: SecurityScopes,
        bearer: HTTPAuthorizationCredentials | None = Security(_bearer_scheme),  # noqa: B008
        api_key_header: str | None = Security(_apikey_scheme),  # noqa: B008
    ) -> Identity:
        return await _resolve_identity_and_check(
            request,
            security_scopes,
            bearer,
            api_key_header,
            method_type=method_type,
        )

    return scoped_auth_check


async def _resolve_identity_and_check(
    request: Request,
    security_scopes: SecurityScopes,
    bearer: HTTPAuthorizationCredentials | None,
    api_key_header: str | None,
    auth: Any = None,
    method_type: str | None = None,
) -> Identity:
    """Core identity resolution and permission checking logic.

    Args:
        request: The incoming request.
        security_scopes: Required scopes from ``Security()``.
        bearer: Bearer token header (for OpenAPI schema).
        api_key_header: API key header (for OpenAPI schema).
        auth: Optional GatewayAuth instance override.
        method_type: ``"use"`` or ``"manage"`` — enables type-based
            permission matching (e.g. ``"Auth.use"`` grants any Auth
            method with ``method_type="use"``).

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

    # Permission check — method_type enables "Auth.use" / "Auth.manage" matching
    if security_scopes.scopes and not identity.can(
        *security_scopes.scopes, method_type=method_type
    ):
        log_warning(
            f"Permission denied for {request.url.path}. "
            f"Required: {security_scopes.scopes}, "
            f"Effective: {list(identity.effective_perms)}"
        )

        raise HTTPException(
            status_code=403,
            detail=f"Insufficient permissions. Required scopes: {security_scopes.scopes}",
        )

    return identity
