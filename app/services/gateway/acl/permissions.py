"""Permission matching engine — re-exports from shared auth module.

New code should import from ``app.shared.auth.permissions`` directly.
"""

# Re-export everything from the shared module for backward compatibility
from app.shared.auth.permissions import (  # noqa: F401
    PERM_ALL,
    check_access,
    has_permission,
    resolve_effective_permissions,
    wildcard_intersection,
)

__all__ = [
    "PERM_ALL",
    "check_access",
    "has_permission",
    "resolve_effective_permissions",
    "wildcard_intersection",
]
