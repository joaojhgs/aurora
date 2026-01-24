"""FastAPI dependencies for Aurora Gateway."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.services.gateway.auth_service import AuthService
    from app.services.gateway.auth import GatewayAuth

# Singleton instance of AuthService
_auth_service: AuthService | None = None
_gateway_auth: GatewayAuth | None = None


def get_auth_service() -> AuthService:
    """Get the AuthService instance."""
    if _auth_service is None:
        raise RuntimeError("AuthService not initialized")
    return _auth_service


def set_auth_service(auth_service: AuthService) -> None:
    """Set the AuthService instance."""
    global _auth_service
    _auth_service = auth_service


def get_gateway_auth() -> GatewayAuth:
    """Get the GatewayAuth instance."""
    if _gateway_auth is None:
        raise RuntimeError("GatewayAuth not initialized")
    return _gateway_auth


def set_gateway_auth(gateway_auth: GatewayAuth) -> None:
    """Set the GatewayAuth instance."""
    global _gateway_auth
    _gateway_auth = gateway_auth
