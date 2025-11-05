"""Base service abstraction for Aurora services.

This module provides BaseService, a base class that all services should inherit from.
It provides:
- Standardized bus access via singleton pattern
- Config reload capability via abstract method
- Lifecycle methods (start, stop)
- Config observer registration
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from app.helpers.aurora_logger import log_debug, log_error, log_info
from app.shared.messaging.bus_init import get_bus_singleton


class BaseService(ABC):
    """Base class for all Aurora services.

    Provides standardized lifecycle management, bus access, and config reload capability.
    All services should inherit from this class and implement the abstract methods.
    """

    def __init__(self, service_name: str):
        """Initialize the base service.

        Args:
            service_name: Name of the service (e.g., "DBService", "TTSService")
        """
        self.service_name = service_name
        self._bus = None
        self._config_observers: list[Any] = []
        self._started = False

    @property
    def bus(self) -> Any:
        """Get the message bus instance (lazy initialization).

        Returns:
            MessageBus instance

        Raises:
            RuntimeError: If bus has not been initialized
        """
        if self._bus is None:
            try:
                self._bus = get_bus_singleton()
            except RuntimeError:
                # Fallback: try to initialize bus for this service
                from app.shared.messaging.bus_init import initialize_bus_for_service

                self._bus = initialize_bus_for_service(self.service_name)
        return self._bus

    @abstractmethod
    async def start(self) -> None:
        """Start the service.

        This method should:
        - Initialize service-specific resources
        - Subscribe to message bus topics
        - Start any background tasks
        - Register config observers if needed
        """
        pass

    @abstractmethod
    async def stop(self) -> None:
        """Stop the service.

        This method should:
        - Stop background tasks
        - Unsubscribe from message bus topics
        - Clean up resources
        - Remove config observers
        """
        pass

    @abstractmethod
    async def reload(self, config_section: str | None = None) -> None:
        """Reload service configuration.

        This method is called when configuration changes. Services should:
        - Reload configuration for the affected section
        - Update internal state accordingly
        - Restart any affected components if necessary

        Args:
            config_section: The configuration section that changed (None = full reload)
        """
        pass

    def _register_config_observer(self, callback: Any) -> None:
        """Register a config observer callback.

        Args:
            callback: Callback function that will be called on config changes
        """
        if callback not in self._config_observers:
            self._config_observers.append(callback)

            # Register with config service
            try:
                from app.shared.config.interface import ConfigAPI

                config_api = ConfigAPI()
                config_api.add_config_observer(callback)
                log_debug(f"Registered config observer for {self.service_name}")
            except Exception as e:
                log_error(f"Failed to register config observer: {e}")

    def _unregister_config_observer(self, callback: Any) -> None:
        """Unregister a config observer callback.

        Args:
            callback: Callback function to remove
        """
        if callback in self._config_observers:
            self._config_observers.remove(callback)

            # Unregister from config service
            try:
                from app.shared.config.interface import ConfigAPI

                config_api = ConfigAPI()
                config_api.remove_config_observer(callback)
                log_debug(f"Unregistered config observer for {self.service_name}")
            except Exception as e:
                log_error(f"Failed to unregister config observer: {e}")

    def _subscribe_to_config_changes(self) -> None:
        """Subscribe to config change events.

        This method subscribes to Config.Changed events and calls reload() when config changes.
        """
        try:
            from app.services.config.topics import ConfigTopics

            async def on_config_changed(envelope: Any) -> None:
                """Handle config change event."""
                payload = envelope.payload
                affected_sections = getattr(payload, "affected_sections", [])
                key_path = getattr(payload, "key_path", None)

                log_info(f"{self.service_name} received config change: {key_path} (sections: {affected_sections})")

                # Determine which section changed
                config_section = None
                if key_path:
                    # Extract section from key_path (e.g., "llm.provider" -> "llm")
                    parts = key_path.split(".")
                    if len(parts) > 0:
                        config_section = parts[0]

                # Reload service configuration
                await self.reload(config_section)

            self.bus.subscribe(ConfigTopics.CHANGED, on_config_changed)
            log_debug(f"{self.service_name} subscribed to config changes")
        except Exception as e:
            log_error(f"Failed to subscribe to config changes: {e}")

    def _is_started(self) -> bool:
        """Check if service is started.

        Returns:
            True if service is started
        """
        return self._started

    def _set_started(self, started: bool) -> None:
        """Set service started state.

        Args:
            started: Whether service is started
        """
        self._started = started
