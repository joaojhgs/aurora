"""Access Control Layer for Aurora Gateway.

Re-exports from the shared auth module for backward compatibility.
New code should import from ``app.shared.auth`` directly.
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
