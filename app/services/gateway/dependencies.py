"""FastAPI dependencies for Aurora Gateway."""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import Request

if TYPE_CHECKING:
    from app.services.gateway.acl.identity import Identity
    from app.services.gateway.auth import GatewayAuth
    from app.services.gateway.webrtc.rtc_client import RTCClient

# Singleton instances
_gateway_auth: GatewayAuth | None = None
_rtc_client: RTCClient | None = None


def get_gateway_auth() -> GatewayAuth:
    """Get the GatewayAuth instance."""
    if _gateway_auth is None:
        raise RuntimeError("GatewayAuth not initialized")
    return _gateway_auth


def set_gateway_auth(gateway_auth: GatewayAuth) -> None:
    """Set the GatewayAuth instance."""
    global _gateway_auth
    _gateway_auth = gateway_auth


def get_rtc_client() -> RTCClient | None:
    """Get the RTCClient instance (None if WebRTC is disabled)."""
    return _rtc_client


def set_rtc_client(rtc_client: RTCClient | None) -> None:
    """Set the RTCClient instance."""
    global _rtc_client
    _rtc_client = rtc_client


def get_current_identity(request: Request) -> Identity:
    """Get the current Identity from the request state.

    This is set by the auth middleware or defaults to ANONYMOUS.

    Args:
        request: The incoming FastAPI request.

    Returns:
        The Identity for the current request.
    """
    from app.services.gateway.acl.identity import ANONYMOUS

    return getattr(request.state, "identity", ANONYMOUS)
