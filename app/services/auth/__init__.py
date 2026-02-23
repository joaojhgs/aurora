"""Auth service for Aurora.

Provides authentication, authorization, pairing, and principal management
as a standalone service communicating via the message bus.
"""

from app.services.auth.service import AuthService

__all__ = ["AuthService"]
