"""Shared authentication primitives for Aurora services.

Provides Identity, permission matching, and audit helpers used by
both the Auth service and the Gateway middleware.
"""

from app.shared.auth.identity import ANONYMOUS, OPEN_PEER, SYSTEM, Identity, build_identity
from app.shared.auth.permissions import (
    PERM_ALL,
    check_access,
    has_permission,
    resolve_effective_permissions,
    wildcard_intersection,
)

__all__ = [
    "ANONYMOUS",
    "Identity",
    "OPEN_PEER",
    "PERM_ALL",
    "SYSTEM",
    "build_identity",
    "check_access",
    "has_permission",
    "resolve_effective_permissions",
    "wildcard_intersection",
]
