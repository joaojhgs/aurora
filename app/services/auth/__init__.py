"""Auth service for Aurora.

Provides authentication, authorization, pairing, and principal management
as a standalone service communicating via the message bus.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.services.auth.service import AuthService

__all__ = ["AuthService"]


def __getattr__(name: str):
    if name == "AuthService":
        from app.services.auth.service import AuthService as _AuthService

        return _AuthService
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
