"""Base service abstraction for Aurora services.

This module provides BaseService, a base class that all services should inherit from.
It provides:
- Standardized bus access via singleton pattern
- Config reload capability via abstract method
- Lifecycle methods (start, stop)
- Config observer registration
- Gateway announcement protocol (for service discovery)
"""

from __future__ import annotations

import contextlib
import uuid
from abc import ABC, abstractmethod
from datetime import datetime
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
        self._summary = summary
        self._capabilities = capabilities or []
        # self.service_name is deprecated, use self.module instead
        # For backward compatibility with logging/bus_init, we can use self.module
        self._bus = None
        self._config_observers: list[Any] = []
        self._started = False

        # Unique instance ID for this service instance (for multiple instances)
        self._instance_id = str(uuid.uuid4())[:8]

        # Gateway announcement settings
        self._announce_to_gateway = True  # Can be disabled for internal services

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
        """Get the message bus instance.

        Always delegates to the global singleton so that when MeshBus
        replaces the inner bus at runtime, all services see the change
        transparently (no stale cached reference).

        Returns:
            MessageBus instance

        Raises:
            RuntimeError: If bus has not been initialized
        """
        try:
            return get_bus_singleton()
        except RuntimeError:
            # Fallback: try to initialize bus for this service
            # (only happens during early startup before the supervisor sets the bus)
            if self._bus is None:
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

        # Announce to gateway (for service discovery)
        await self._publish_service_announcement()

    async def stop(self) -> None:
        """Stop the service.

        This method:
        1. Announces departure to gateway
        2. Calls the service-specific on_stop() hook
        3. Sets started state to False
        """
        if not self._started:
            return

        # Announce departure to gateway
        await self._publish_service_departure()

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
        3. Method execution (passing Envelope if method accepts it, else payload)
        4. Response publishing (if reply_to is set)
        """
        import inspect

        from app.messaging import Envelope

        def _wants_envelope(method: Any) -> bool:
            """Check if method signature has an 'envelope' parameter."""
            try:
                sig = inspect.signature(method)
                return "envelope" in sig.parameters
            except (ValueError, TypeError):
                return False

        for attr_name in dir(self):
            try:
                attr = getattr(self, attr_name)
                if hasattr(attr, "_contract_metadata"):
                    metadata = attr._contract_metadata
                    # Use method_id as topic (e.g., "TTS.Request", "Config.Get")
                    topic = metadata.get("bus_topic") or metadata.get("method_id")
                    input_model = metadata.get("input_model")

                    if topic:
                        # Create a wrapper to handle the envelope and types
                        async def create_wrapper(
                            method=attr,
                            model=input_model,
                            method_name=attr_name,
                            pass_envelope=_wants_envelope(attr),
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
                                            # Send error response if reply_to is set
                                            if envelope.reply_to:
                                                from app.shared.contracts.models.common import (
                                                    ErrorOutput,
                                                )

                                                error_response = ErrorOutput(
                                                    error=f"Validation error: {e}",
                                                    code="VALIDATION_ERROR",
                                                )
                                                await self.bus.publish(
                                                    envelope.reply_to,
                                                    error_response,
                                                    event=False,
                                                    origin=self.module,
                                                )
                                            return

                                        # 2. Execute method
                                        if pass_envelope:
                                            result = await method(data, envelope=envelope)
                                        else:
                                            result = await method(data)
                                    else:
                                        # No input model, pass payload directly
                                        if pass_envelope:
                                            result = await method(
                                                envelope.payload, envelope=envelope
                                            )
                                        else:
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

    async def health_check(self) -> dict[str, Any]:
        """Perform health check for the service.

        Returns:
            Dictionary with health status:
            {
                "status": "healthy" | "degraded" | "unhealthy",
                "checks": {
                    "bus": "ok" | "error",
                    "config": "ok" | "error",
                    ...
                },
                "timestamp": "2025-01-XX...",
                "service": "ServiceName"
            }
        """

        checks = {}
        status = "healthy"

        # Check bus connectivity
        try:
            _ = self.bus
            checks["bus"] = "ok"
        except Exception as e:
            checks["bus"] = f"error: {str(e)}"
            status = "unhealthy"

        # Check config access
        try:
            from app.shared.config.interface import ConfigAPI

            config_api = ConfigAPI()
            _ = config_api.get_config()
            checks["config"] = "ok"
        except Exception as e:
            checks["config"] = f"error: {str(e)}"
            status = "degraded"

        return {
            "status": status,
            "checks": checks,
            "timestamp": datetime.utcnow().isoformat(),
            "service": self.module,
        }

    # =========================================================================
    # Gateway Announcement Protocol
    # =========================================================================

    async def _publish_service_announcement(self) -> None:
        """Announce this service to the gateway for discovery.

        Called automatically after on_start() completes.
        Publishes service metadata including all exposed methods.
        """
        if not self._announce_to_gateway:
            return

        # Skip announcement for Gateway itself
        if self.module == "Gateway":
            return

        try:
            from app.shared.contracts.models.gateway import (
                GatewayMethods,
                MethodInfo,
                ServiceAnnouncement,
            )
            from app.shared.contracts.registry import list_modules

            # Get module information from registry
            modules = list_modules()
            module_contract = modules.get(self.module)

            if module_contract is None:
                log_debug(f"No module contract found for {self.module}, skipping announcement")
                return

            # Build method info list with schemas
            methods = []
            for method in module_contract.methods:
                # Extract JSON schemas from Pydantic models
                input_schema = None
                output_schema = None

                if method.input_model is not None:
                    with contextlib.suppress(Exception):
                        input_schema = method.input_model.model_json_schema()

                if method.output_model is not None:
                    with contextlib.suppress(Exception):
                        output_schema = method.output_model.model_json_schema()

                methods.append(
                    MethodInfo(
                        name=method.name,
                        summary=method.summary,
                        bus_topic=method.bus_topic,
                        exposure=method.exposure,
                        input_model=method.input_model.__name__ if method.input_model else None,
                        output_model=method.output_model.__name__ if method.output_model else None,
                        required_perms=method.required_perms,
                        method_type=method.method_type,
                        input_schema=input_schema,
                        output_schema=output_schema,
                    )
                )

            # Create announcement
            announcement = ServiceAnnouncement(
                module=self.module,
                version=module_contract.version,
                summary=self._summary or module_contract.summary,
                capabilities=self._capabilities or module_contract.capabilities,
                methods=methods,
                instance_id=self._instance_id,
            )

            # Publish announcement as event
            await self.bus.publish(
                GatewayMethods.SERVICE_ANNOUNCE,
                announcement,
                event=True,
                origin=self.module,
            )

            log_debug(
                f"Announced {self.module} to gateway "
                f"({len(methods)} methods, instance: {self._instance_id})"
            )

        except Exception as e:
            # Don't fail service startup if announcement fails
            log_error(f"Failed to announce {self.module} to gateway: {e}")

    async def _publish_service_departure(self) -> None:
        """Announce service departure to the gateway.

        Called automatically before on_stop().
        """
        if not self._announce_to_gateway:
            return

        # Skip announcement for Gateway itself
        if self.module == "Gateway":
            return

        try:
            from app.shared.contracts.models.gateway import (
                GatewayMethods,
                ServiceDeparture,
            )

            departure = ServiceDeparture(
                module=self.module,
                instance_id=self._instance_id,
                reason="shutdown",
            )

            await self.bus.publish(
                GatewayMethods.SERVICE_DEPART,
                departure,
                event=True,
                origin=self.module,
            )

            log_debug(f"Announced departure of {self.module} (instance: {self._instance_id})")

        except Exception as e:
            # Don't fail service shutdown if departure fails
            log_error(f"Failed to announce departure of {self.module}: {e}")

    async def _publish_heartbeat(self) -> None:
        """Publish a heartbeat to the gateway.

        Services can call this periodically to indicate they're still alive.
        Not called automatically - services must implement their own heartbeat logic if needed.
        """
        if not self._announce_to_gateway or not self._started:
            return

        try:
            from app.shared.contracts.models.gateway import (
                GatewayMethods,
                ServiceHeartbeat,
            )

            heartbeat = ServiceHeartbeat(
                module=self.module,
                instance_id=self._instance_id,
            )

            await self.bus.publish(
                GatewayMethods.SERVICE_HEARTBEAT,
                heartbeat,
                event=True,
                origin=self.module,
            )

        except Exception as e:
            log_error(f"Failed to send heartbeat for {self.module}: {e}")
