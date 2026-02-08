"""Access Control Layer for Aurora Gateway.

Provides granular permission-based access control for HTTP and WebRTC paths.
"""

from app.services.gateway.acl.identity import ANONYMOUS, SYSTEM, Identity, build_identity
from app.services.gateway.acl.permissions import (
    PERM_ALL,
    PERM_AUTH_APPROVE,
    PERM_AUTH_AUDIT,
    PERM_AUTH_MANAGE,
    PERM_SYSTEM_CONTROL,
    check_access,
    has_permission,
    resolve_effective_permissions,
    wildcard_intersection,
)

__all__ = [
    "ANONYMOUS",
    "Identity",
    "PERM_ALL",
    "PERM_AUTH_APPROVE",
    "PERM_AUTH_AUDIT",
    "PERM_AUTH_MANAGE",
    "PERM_SYSTEM_CONTROL",
    "SYSTEM",
    "build_identity",
    "check_access",
    "has_permission",
    "resolve_effective_permissions",
    "wildcard_intersection",
]
