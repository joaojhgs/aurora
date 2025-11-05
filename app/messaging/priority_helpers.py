"""Priority helper utilities for message bus operations.

Provides config-based priority lookup functions to ensure consistent
priority usage across services.
"""

from app.shared.config.interface import ConfigAPI

config_api = ConfigAPI()


def get_priority(level: str) -> int:
    """Get priority value from config for a given level.

    Args:
        level: Priority level name ("interactive", "system", "external")

    Returns:
        Priority value (0-99, lower is higher priority)

    Examples:
        >>> get_priority("interactive")  # Returns 10 (default)
        >>> get_priority("system")       # Returns 50 (default)
        >>> get_priority("external")     # Returns 80 (default)
    """
    default_priorities = {
        "interactive": 10,
        "system": 50,
        "external": 80,
    }

    try:
        return config_api.get(f"messaging.priorities.{level}", default_priorities.get(level, 50))
    except Exception:
        # Fallback to defaults if config lookup fails
        return default_priorities.get(level, 50)


def get_interactive_priority() -> int:
    """Get priority for interactive/internal operations.

    Returns:
        Priority value (default: 10)
    """
    return get_priority("interactive")


def get_system_priority() -> int:
    """Get priority for system/background operations.

    Returns:
        Priority value (default: 50)
    """
    return get_priority("system")


def get_external_priority() -> int:
    """Get priority for external connectivity operations.

    Returns:
        Priority value (default: 80)
    """
    return get_priority("external")
