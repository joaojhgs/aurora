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

    def __init__(self, module: str, summary: str = "", capabilities: list[str] | None = None):
        """Initialize the base service.

        Args:
            module: Module name (e.g., "TTS", "DB", "Scheduler")
            summary: Brief description of the service module
            capabilities: List of capabilities provided by the service
        """
        self.module = module
        # self.service_name is deprecated, use self.module instead
        # For backward compatibility with logging/bus_init, we can use self.module
        self._bus = None
        self._config_observers: list[Any] = []
        self._started = False

        # Register module
        from app.shared.contracts.registry import register_method, register_module

        register_module(module, summary=summary, capabilities=capabilities or [])

        # Auto-register method contracts with validation
        for attr_name in dir(self):
            try:
                attr = getattr(self, attr_name)
                if hasattr(attr, "_contract_metadata"):
                    metadata = attr._contract_metadata
                    method_id = metadata.get("method_id")

                    if method_id:
                        # Validate format: must contain "."
                        if "." not in method_id:
                            raise ValueError(
                                f"Invalid method_id '{method_id}': must be in format 'Module.Method'"
                            )

                        # Parse: "TTS.Request" -> module="TTS", name="Request"
                        parsed_module, method_name = method_id.split(".", 1)

                        # Validate module name matches
                        if parsed_module != module:
                            raise ValueError(
                                f"Method {method_id} module mismatch: "
                                f"expected {module}, got {parsed_module}"
                            )

                        # Set metadata for registration
                        metadata["module"] = module
                        metadata["name"] = method_name
                        metadata["bus_topic"] = method_id

                        # Register the method
                        register_method(module, method_name, attr, metadata)
                        log_debug(f"Registered contract: {method_id}")
            except Exception as e:
                log_error(f"Error registering contract for {attr_name}: {e}")

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

                self._bus = initialize_bus_for_service(self.module)
        return self._bus

    async def start(self) -> None:
        """Start the service.

        This method:
        1. Initializes the bus (if needed)
        2. Auto-subscribes to registered contracts
        3. Calls the service-specific on_start() hook
        4. Sets started state to True
        """
        if self._started:
            return

        # Ensure bus is initialized
        _ = self.bus

        # Auto-subscribe to registered contracts
        await self._subscribe_registered_contracts()

        # Call service-specific startup logic
        await self.on_start()

        self._set_started(True)
        log_info(f"{self.module} started")

    async def stop(self) -> None:
        """Stop the service.

        This method:
        1. Calls the service-specific on_stop() hook
        2. Sets started state to False
        """
        if not self._started:
            return

        # Call service-specific shutdown logic
        await self.on_stop()

        self._set_started(False)
        log_info(f"{self.module} stopped")

    @abstractmethod
    async def on_start(self) -> None:
        """Service-specific startup logic.

        Implement this method to:
        - Initialize service-specific resources
        - Start background tasks
        - Register config observers
        """
        pass

    @abstractmethod
    async def on_stop(self) -> None:
        """Service-specific shutdown logic.

        Implement this method to:
        - Stop background tasks
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
                log_debug(f"Registered config observer for {self.module}")
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
                log_debug(f"Unregistered config observer for {self.module}")
            except Exception as e:
                log_error(f"Failed to unregister config observer: {e}")

    def _subscribe_to_config_changes(self) -> None:
        """Subscribe to config change events.

        This method subscribes to Config.Changed events and calls reload() when config changes.
        """
        try:
            from app.shared.contracts.models.config import ConfigMethods

            async def on_config_changed(envelope: Any) -> None:
                """Handle config change event."""
                payload = envelope.payload
                affected_sections = getattr(payload, "affected_sections", [])
                key_path = getattr(payload, "key_path", None)

                log_info(
                    f"{self.module} received config change: {key_path} (sections: {affected_sections})"
                )

                # Determine which section changed
                config_section = None
                if key_path:
                    # Extract section from key_path (e.g., "llm.provider" -> "llm")
                    parts = key_path.split(".")
                    if len(parts) > 0:
                        config_section = parts[0]

                # Reload service configuration
                await self.reload(config_section)

            self.bus.subscribe(ConfigMethods.UPDATED, on_config_changed)
            log_debug(f"{self.module} subscribed to config changes")
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

    async def _subscribe_registered_contracts(self) -> None:
        """Subscribe all registered method contracts to the message bus.

        This method scans for methods decorated with @method_contract that have
        a bus_topic defined, and subscribes them to that topic.
        It wraps the method to handle:
        1. Envelope unpacking
        2. Input model validation
        3. Method execution
        4. Response publishing (if reply_to is set)
        """
        from app.messaging import Envelope

        for attr_name in dir(self):
            try:
                attr = getattr(self, attr_name)
                if hasattr(attr, "_contract_metadata"):
                    metadata = attr._contract_metadata
                    topic = metadata.get("bus_topic")
                    input_model = metadata.get("input_model")

                    if topic:
                        # Create a wrapper to handle the envelope and types
                        async def create_wrapper(
                            method=attr, model=input_model, method_name=attr_name
                        ):
                            async def wrapper(envelope: Envelope) -> None:
                                try:
                                    # 1. Unpack and validate input
                                    if model:
                                        try:
                                            # Check if payload is already the correct type
                                            if isinstance(envelope.payload, model):
                                                data = envelope.payload
                                            elif isinstance(envelope.payload, dict):
                                                data = model.model_validate(envelope.payload)
                                            else:
                                                # Try to convert (e.g., from Pydantic model)
                                                data = model.model_validate(
                                                    envelope.payload.model_dump()
                                                    if hasattr(envelope.payload, "model_dump")
                                                    else envelope.payload
                                                )
                                        except Exception as e:
                                            log_error(
                                                f"Input validation failed for {method_name}: {e}"
                                            )
                                            return

                                        # 2. Execute method
                                        result = await method(data)
                                    else:
                                        # No input model, pass payload directly?
                                        # Or pass nothing if it takes no args?
                                        # For now, assume it takes payload if no model
                                        result = await method(envelope.payload)

                                    # 3. Handle response
                                    if result is not None and envelope.reply_to:
                                        # If the result is an IOModel, dump it
                                        payload = result
                                        # Publish response
                                        await self.bus.publish(
                                            envelope.reply_to,
                                            payload,
                                            event=False,
                                            origin=self.module,  # Responses are point-to-point replies
                                        )
                                        log_debug(
                                            f"Sent response for {method_name} to {envelope.reply_to}"
                                        )
                                    elif result is not None:
                                        # Result returned but no reply_to - just log
                                        log_debug(
                                            f"Method {method_name} returned result but no reply_to set"
                                        )

                                except Exception as e:
                                    log_error(
                                        f"Error executing contract method {method_name}: {e}",
                                        exc_info=True,
                                    )
                                    # Optionally send error response if reply_to is set
                                    if envelope.reply_to:
                                        # Send error response
                                        from app.shared.contracts.models.common import ErrorOutput

                                        error_response = ErrorOutput(error=str(e))
                                        await self.bus.publish(
                                            envelope.reply_to,
                                            error_response,
                                            event=False,
                                            origin=self.module,
                                        )

                            return wrapper

                        # Subscribe with the wrapper
                        handler = await create_wrapper()
                        self.bus.subscribe(topic, handler)
                        log_info(f"Auto-subscribed {attr_name} to {topic}")

            except Exception as e:
                log_error(f"Error setting up subscription for {attr_name}: {e}")
