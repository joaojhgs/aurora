"""Identity dataclass — re-exports from shared auth module.

New code should import from ``app.shared.auth.identity`` directly.
"""

# Re-export everything from the shared module for backward compatibility
from app.shared.auth.identity import (  # noqa: F401
    ANONYMOUS,
    OPEN_PEER,
    SYSTEM,
    Identity,
    build_identity,
)

__all__ = [
    "ANONYMOUS",
    "Identity",
    "OPEN_PEER",
    "SYSTEM",
    "build_identity",
]
