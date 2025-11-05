"""Bus initialization utilities with singleton pattern for threads and processes modes.

This module provides enhanced singleton pattern for bus access:
- Threads mode: Global singleton shared across all services in same process
- Processes mode: Per-service singleton (each service process has its own instance)
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.messaging.bus import MessageBus

# Global singleton for threads mode
_bus: MessageBus | None = None

# Per-service singletons for processes mode
_service_buses: dict[str, MessageBus] = {}


def set_bus(bus: MessageBus) -> None:
    """Set the global MessageBus instance (threads mode).

    This function also updates the legacy bus_runtime singleton for backward compatibility.

    Args:
        bus: MessageBus implementation to use globally
    """
    global _bus
    _bus = bus
    
    # Also update legacy bus_runtime for backward compatibility
    try:
        from app.messaging.bus_runtime import set_bus as set_runtime_bus
        set_runtime_bus(bus)
    except Exception:
        pass  # Ignore if bus_runtime not available


def get_bus() -> MessageBus:
    """Get the global MessageBus instance (threads mode).

    Returns:
        The configured MessageBus instance

    Raises:
        RuntimeError: If bus has not been initialized via set_bus()
    """
    if _bus is None:
        raise RuntimeError("MessageBus not initialized. Call set_bus() before using get_bus().")
    return _bus


def set_bus_for_service(service_name: str, bus: MessageBus) -> None:
    """Set the MessageBus instance for a specific service (processes mode).

    Args:
        service_name: Name of the service
        bus: MessageBus implementation for this service
    """
    _service_buses[service_name] = bus


def get_bus_for_service(service_name: str) -> MessageBus:
    """Get the MessageBus instance for a specific service (processes mode).

    Args:
        service_name: Name of the service

    Returns:
        The configured MessageBus instance for this service

    Raises:
        RuntimeError: If bus has not been initialized for this service
    """
    if service_name not in _service_buses:
        raise RuntimeError(f"MessageBus not initialized for service '{service_name}'. Call set_bus_for_service() before using get_bus_for_service().")
    return _service_buses[service_name]


def initialize_bus_for_service(service_name: str) -> MessageBus:
    """Initialize bus singleton for a service (processes mode).

    This function:
    1. Determines the mode (threads vs processes)
    2. Creates the appropriate bus instance
    3. Registers it for the service
    4. Returns the bus instance

    Args:
        service_name: Name of the service

    Returns:
        The initialized MessageBus instance
    """
    from app.shared.config.interface import ConfigAPI

    config_api = ConfigAPI()
    from app.helpers.aurora_logger import log_info
    from app.messaging.bullmq_bus import BullMQBus
    from app.messaging.local_bus import LocalBus

    # Get architecture mode from config
    mode = config_api.get("general.architecture.mode", "threads")

    if mode == "threads":
        # In threads mode, use global singleton
        if _bus is None:
            bus = LocalBus(command_queue_size=1000, event_queue_size=5000)
            set_bus(bus)
            log_info("Initialized LocalBus (threads mode) for service")
        return get_bus()
    elif mode == "processes":
        # In processes mode, create per-service singleton
        if service_name not in _service_buses:
            # Get Redis URL from config
            redis_url = config_api.get("messaging.redis.url", "redis://localhost:6379")
            bus = BullMQBus(redis_url=redis_url)
            set_bus_for_service(service_name, bus)
            log_info(f"Initialized BullMQBus (processes mode) for service '{service_name}'")
        return get_bus_for_service(service_name)
    else:
        raise ValueError(f"Unknown architecture mode: {mode}")


def get_bus_singleton() -> MessageBus:
    """Get the bus singleton (works in both modes).

    This function automatically detects the mode and returns the appropriate bus:
    - Threads mode: Returns global singleton
    - Processes mode: Returns per-service singleton (requires service context)

    Returns:
        The MessageBus instance

    Raises:
        RuntimeError: If bus has not been initialized
    """
    # Try global singleton first (threads mode)
    if _bus is not None:
        return _bus

    # In processes mode, we need service context
    # This is a fallback - services should use initialize_bus_for_service() or get_bus_for_service()
    if _service_buses:
        # Return first available service bus (for processes mode)
        return next(iter(_service_buses.values()))

    raise RuntimeError("MessageBus not initialized. Call set_bus() or initialize_bus_for_service() before using get_bus_singleton().")
