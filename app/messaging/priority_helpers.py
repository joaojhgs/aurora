"""Priority helper utilities for message bus operations.

Provides environment variable-based priority lookup functions to ensure consistent
priority usage across services without depending on ConfigService.
"""

import os


def get_priority(level: str) -> int:
    """Get priority value from environment variable for a given level.

    Args:
        level: Priority level name ("interactive", "system", "external")

    Returns:
        Priority value (0-99, lower is higher priority)

    Examples:
        >>> get_priority("interactive")  # Returns 10 (default or AURORA_MESSAGING_PRIORITY_INTERACTIVE)
        >>> get_priority("system")       # Returns 50 (default or AURORA_MESSAGING_PRIORITY_SYSTEM)
        >>> get_priority("external")     # Returns 80 (default or AURORA_MESSAGING_PRIORITY_EXTERNAL)
    """
    default_priorities = {
        "interactive": 10,
        "system": 50,
        "external": 80,
    }

    # Get priority from environment variable
    env_var_name = f"AURORA_MESSAGING_PRIORITY_{level.upper()}"
    env_value = os.getenv(env_var_name)

    if env_value:
        try:
            return int(env_value)
        except ValueError:
            # Invalid value, fall back to default
            pass

    # Fallback to default
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
