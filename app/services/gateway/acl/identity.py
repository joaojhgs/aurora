"""Identity dataclass for representing an authenticated principal's permissions.

Every authenticated entity — HTTP bearer token user, API key, or WebRTC peer —
is represented as an :class:`Identity`.  The identity carries the *effective
permissions* which are the intersection of (or union of, for admins) the
principal's user-level permissions and the token-level scopes.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.services.gateway.acl.permissions import (
    check_access,
    resolve_effective_permissions,
)


@dataclass
class Identity:
    """Represents the authenticated identity of a principal (user/device/token).

    Attributes:
        principal_id: Unique identifier for the user or device.
        principal_name: Human-readable name (username / device name).
        is_admin: Whether the principal has administrative access.
        permissions: The principal's *user-level* permission set (before
            token scope intersection).
        effective_perms: Pre-computed set of effective permissions
            (intersection of user perms and token scopes).
        device_id: Optional device identifier (for paired devices).
        source: How authentication was established (e.g. ``"http_bearer"``,
            ``"webrtc_peer"``, ``"api_key"``).
        metadata: Arbitrary extra data.
    """

    principal_id: str
    principal_name: str = ""
    is_admin: bool = False
    permissions: frozenset[str] = field(default_factory=frozenset)
    effective_perms: frozenset[str] = field(default_factory=frozenset)
    device_id: str | None = None
    source: str = "unknown"
    metadata: dict[str, Any] = field(default_factory=dict)

    # ── Convenience permission checkers ──────────────────────────────────

    def can(self, *permissions: str) -> bool:
        """Check whether the identity has **all** given permissions.

        Admin identities always return True.

        Args:
            permissions: Permission strings to check (e.g. ``"TTS.Say"``).

        Returns:
            ``True`` if every permission is satisfied.
        """
        if self.is_admin:
            return True
        return check_access(set(self.effective_perms), list(permissions))

    def has_permission(self, permission: str) -> bool:
        """Alias for ``can(permission)``."""
        return self.can(permission)

    def has_all_permissions(self, required_permissions: list[str]) -> bool:
        """Check if the identity has all required permissions."""
        return self.can(*required_permissions)


# ── Sentinel identities ─────────────────────────────────────────────────

#: Anonymous identity for unauthenticated peers (no permissions).
ANONYMOUS: Identity = Identity(
    principal_id="anonymous",
    principal_name="anonymous",
    is_admin=False,
    permissions=frozenset(),
    effective_perms=frozenset(),
    source="none",
)

#: Full-access identity for internal / API-key usage.
SYSTEM: Identity = Identity(
    principal_id="system",
    principal_name="SYSTEM",
    is_admin=True,
    permissions=frozenset(["*"]),
    effective_perms=frozenset(["*"]),
    source="system",
)


# ── Builder ──────────────────────────────────────────────────────────────

def build_identity(
    *,
    user_id: str,
    username: str,
    user_permissions: list[str],
    user_is_admin: bool,
    token_scopes: list[str],
    device_id: str | None = None,
    source: str = "http_bearer",
) -> Identity:
    """Build an :class:`Identity` by resolving effective permissions.

    Effective permissions are determined via
    :func:`~app.services.gateway.acl.permissions.resolve_effective_permissions`.

    Args:
        user_id: Principal ID.
        username: Principal name.
        user_permissions: Permissions stored on the user record.
        user_is_admin: Admin flag on the user record.
        token_scopes: Scopes stored on the token.
        device_id: Optional device identifier.
        source: Authentication source label.

    Returns:
        Fully resolved :class:`Identity`.
    """
    effective = resolve_effective_permissions(
        user_permissions=user_permissions,
        user_is_admin=user_is_admin,
        token_scopes=token_scopes,
    )

    return Identity(
        principal_id=user_id,
        principal_name=username,
        is_admin=user_is_admin,
        permissions=frozenset(user_permissions),
        effective_perms=frozenset(effective),
        device_id=device_id,
        source=source,
    )
