"""Runtime singleton for accessing the global MessageBus instance.

This module provides a global accessor for the message bus, allowing
services to obtain the bus instance without tight coupling.
"""

from __future__ import annotations

from .bus import MessageBus

_bus: MessageBus | None = None


def set_bus(bus: MessageBus) -> None:
    """Set the global MessageBus instance.

    Args:
        bus: MessageBus implementation to use globally
    """
    global _bus
    _bus = bus


def get_bus() -> MessageBus:
    """Get the global MessageBus instance.

    Returns:
        The configured MessageBus instance

    Raises:
        RuntimeError: If bus has not been initialized via set_bus()
    """
    if _bus is None:
        raise RuntimeError("MessageBus not initialized. Call set_bus() before using get_bus().")
    return _bus
