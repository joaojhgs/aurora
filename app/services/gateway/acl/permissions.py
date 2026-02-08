"""Permission matching engine for Aurora Gateway.

Pure functions — no dependencies on DB, HTTP, or any I/O.
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Well-known permission constants
# ---------------------------------------------------------------------------

PERM_ALL = "*"
PERM_AUTH_MANAGE = "auth.manage"
PERM_AUTH_APPROVE = "auth.approve"
PERM_AUTH_AUDIT = "auth.audit"
PERM_SYSTEM_CONTROL = "system.control"


# ---------------------------------------------------------------------------
# Core matching
# ---------------------------------------------------------------------------


def has_permission(required: str, granted_perms: set[str]) -> bool:
    """Check if a single *required* permission is satisfied by *granted_perms*.

    Matching rules (evaluated in order):
    1. ``"*"`` in granted_perms → always True  (superuser wildcard)
    2. Exact match ``required in granted_perms``
    3. Wildcard: ``"prefix.*"`` in granted_perms matches any permission
       that starts with ``"prefix."``. Supports multi-level wildcards
       (e.g. ``"device.status.*"`` matches ``"device.status.get"``).

    Args:
        required: The permission string that is needed.
        granted_perms: The set of permissions the principal holds.

    Returns:
        True if *required* is satisfied by *granted_perms*.
    """
    # 1. Superuser wildcard
    if PERM_ALL in granted_perms:
        return True

    # 2. Exact match
    if required in granted_perms:
        return True

    # 3. Wildcard matching at any level
    if "." in required:
        required_parts = required.split(".")
        for perm in granted_perms:
            if perm.endswith(".*"):
                prefix_parts = perm[:-2].split(".")  # Strip ".*" then split
                if len(prefix_parts) < len(required_parts) and required_parts[: len(prefix_parts)] == prefix_parts:
                    return True

    return False


def check_access(effective_perms: set[str], required_perms: list[str]) -> bool:
    """Check that **all** *required_perms* are satisfied.

    Args:
        effective_perms: Resolved effective permissions for the principal.
        required_perms: List of permissions that must all be present.

    Returns:
        True only if every required permission is matched.
    """
    return all(has_permission(r, effective_perms) for r in required_perms)


# ---------------------------------------------------------------------------
# Wildcard-aware intersection
# ---------------------------------------------------------------------------


def wildcard_intersection(user_perms: set[str], token_scopes: set[str]) -> set[str]:
    """Compute the wildcard-aware intersection of user permissions and token scopes.

    Both sides may contain wildcards (``"*"``, ``"TTS.*"``).

    Examples::

        wildcard_intersection({"TTS.*"}, {"TTS.Request"})
            → {"TTS.Request"}
        wildcard_intersection({"TTS.Request"}, {"TTS.*"})
            → {"TTS.Request"}
        wildcard_intersection({"TTS.*", "STT.*"}, {"TTS.Request", "DB.Get"})
            → {"TTS.Request"}

    Args:
        user_perms: Principal-level permissions.
        token_scopes: Token-level scope restrictions.

    Returns:
        Set of effective permissions (the intersection).
    """
    effective: set[str] = set()

    for scope in token_scopes:
        if has_permission(scope, user_perms):
            # The scope itself is covered by user perms — include it as-is.
            effective.add(scope)
        elif _is_wildcard(scope):
            # Token has a wildcard (e.g. "TTS.*") — pick user perms that fall under it.
            for up in user_perms:
                if has_permission(up, {scope}):
                    effective.add(up)

    return effective


# ---------------------------------------------------------------------------
# Effective permission resolution
# ---------------------------------------------------------------------------


def resolve_effective_permissions(
    user_permissions: list[str],
    user_is_admin: bool,
    token_scopes: list[str],
) -> set[str]:
    """Compute effective permissions for a request.

    Resolution rules:
    1. Admin shortcut → ``{"*"}``
    2. Token scopes contain ``"*"`` or ``"all"`` → inherit all user perms.
    3. Otherwise → ``wildcard_intersection(user_perms, token_scopes)``.

    Args:
        user_permissions: The principal's stored permission list.
        user_is_admin: Whether the principal has the admin flag.
        token_scopes: The scopes declared on the token.

    Returns:
        Resolved effective permission set.
    """
    if user_is_admin:
        return {PERM_ALL}

    user_perms = set(user_permissions)
    scopes = set(token_scopes)

    # Token with full access → inherit all user perms
    if PERM_ALL in scopes or "all" in scopes:
        return user_perms

    return wildcard_intersection(user_perms, scopes)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _is_wildcard(perm: str) -> bool:
    """Return True if *perm* is a wildcard permission."""
    return perm == PERM_ALL or perm.endswith(".*")
