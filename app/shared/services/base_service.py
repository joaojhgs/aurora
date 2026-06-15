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

import asyncio
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
        self._gateway_announcement_task: asyncio.Task | None = None
        self._config_change_subscription: tuple[str, Any] | None = None
        self._contract_subscriptions: list[tuple[str, Any]] = []
        self._runtime_state = "created"
        self._started = False

        # Unique instance ID for this service instance (for multiple instances)
        self._instance_id = str(uuid.uuid4())[:8]

        # Gateway announcement settings
        self._announce_to_gateway = True  # Can be disabled for internal services

        # Register module
        from app.shared.contracts.registry import register_method, register_module

        register_module(module, summary=summary, capabilities=capabilities or [])

        # Auto-register method contracts with validation
        import inspect

        for attr_name in dir(self):
            try:
                descriptor = inspect.getattr_static(self, attr_name, None)
                if isinstance(descriptor, property):
                    continue
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
        2. Subscribes to config updates for runtime lifecycle changes
        3. Activates the service if its enabled path is true
        4. Leaves the service inactive, but alive, if disabled by config
        """
        if self._started:
            return

        # Ensure bus is initialized
        _ = self.bus

        self._runtime_state = "starting"
        self._set_started(True)
        self._subscribe_to_config_changes()

        if await self._is_runtime_enabled():
            await self.activate(reason="startup")
        else:
            self._runtime_state = "inactive"
            log_info(f"{self.module} inactive because its enabled config is false")

    async def activate(self, reason: str = "config_enabled") -> None:
        """Activate this service's runtime contract surface."""
        if self._runtime_state == "active":
            return

        self._runtime_state = "starting"
        try:
            await self._subscribe_registered_contracts()
            await self.on_start()
        except Exception:
            self._unsubscribe_registered_contracts()
            self._runtime_state = "failed"
            self._set_started(False)
            raise

        self._set_started(True)
        self._runtime_state = "active"
        log_info(f"{self.module} active ({reason})")

        await self._publish_service_announcement()
        self._start_gateway_announcement_loop()

    async def deactivate(self, reason: str = "config_disabled") -> None:
        """Deactivate this service without exiting the hosting process/container."""
        if self._runtime_state != "active":
            if self._started:
                self._runtime_state = "inactive"
            return

        self._runtime_state = "stopping"
        self._stop_gateway_announcement_loop()
        await self._publish_service_departure(reason=reason)
        self._unsubscribe_registered_contracts()
        try:
            await self.on_deactivate()
        except Exception as e:
            log_error(f"{self.module} deactivation hook failed: {e}", exc_info=True)
        self._set_started(True)
        self._runtime_state = "inactive"
        log_info(f"{self.module} inactive ({reason})")

    async def stop(self) -> None:
        """Stop the service.

        This method:
        1. Deactivates the runtime contract surface when active
        2. Unsubscribes config listeners
        3. Marks the service process lifecycle stopped
        """
        if not self._started:
            return

        if self._runtime_state == "active":
            await self.deactivate(reason="shutdown")
        elif self._runtime_state in ("created", "starting", "failed"):
            await self.on_stop()
        else:
            self._stop_gateway_announcement_loop()
            self._unsubscribe_registered_contracts()

        self._unsubscribe_from_config_changes()
        self._runtime_state = "stopped"
        self._set_started(False)
        log_info(f"{self.module} stopped")

    def _start_gateway_announcement_loop(self) -> None:
        """Periodically re-announce service metadata for gateway restarts."""
        if not self._announce_to_gateway or self.module == "Gateway":
            return
        if self._gateway_announcement_task and not self._gateway_announcement_task.done():
            return
        self._gateway_announcement_task = asyncio.create_task(self._gateway_announcement_loop())

    def _stop_gateway_announcement_loop(self) -> None:
        """Stop the periodic gateway announcement task."""
        if self._gateway_announcement_task:
            self._gateway_announcement_task.cancel()
            self._gateway_announcement_task = None

    async def _gateway_announcement_loop(self) -> None:
        """Keep service discovery warm when Gateway restarts independently."""
        try:
            while self._runtime_state == "active":
                await asyncio.sleep(30)
                await self._publish_service_announcement()
        except asyncio.CancelledError:
            pass

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

    async def on_deactivate(self) -> None:
        """Service-specific runtime deactivation hook.

        The default deactivation path reuses the full stop hook. Services that
        need lighter config-driven dormancy can override this without changing
        process shutdown behavior.
        """
        await self.on_stop()

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
        if self.module == "Config":
            return
        if self._config_change_subscription is not None:
            return
        try:
            from app.shared.contracts.models.config import ConfigMethods

            async def on_config_changed(envelope: Any) -> None:
                """Handle config change event."""
                await self._handle_config_changed(envelope.payload)

            self.bus.subscribe(ConfigMethods.UPDATED, on_config_changed)
            self._config_change_subscription = (ConfigMethods.UPDATED, on_config_changed)
            log_debug(f"{self.module} subscribed to config changes")
        except Exception as e:
            log_error(f"Failed to subscribe to config changes: {e}")

    def _unsubscribe_from_config_changes(self) -> None:
        """Remove the config change subscription when the process is stopping."""
        if self._config_change_subscription is None:
            return
        topic, handler = self._config_change_subscription
        try:
            self.bus.unsubscribe(topic, handler)
        except Exception as e:
            log_error(f"Failed to unsubscribe {self.module} from config changes: {e}")
        self._config_change_subscription = None

    async def _handle_config_changed(self, payload: Any) -> None:
        """Normalize and apply a Config.Updated payload."""
        try:
            from app.services.config.messages import ConfigChangedEvent

            if isinstance(payload, ConfigChangedEvent):
                event = payload
            elif isinstance(payload, dict):
                event = ConfigChangedEvent.model_validate(payload)
            elif hasattr(payload, "model_dump"):
                event = ConfigChangedEvent.model_validate(payload.model_dump())
            else:
                event = ConfigChangedEvent.model_validate(payload)
        except Exception as e:
            log_error(f"{self.module} could not decode config change payload: {e}")
            return

        log_info(
            f"{self.module} received config change: "
            f"{event.key_path} (sections: {event.affected_sections})"
        )

        enabled_path = self._enabled_config_path()
        if enabled_path and self._event_matches_enabled_path(event.key_path, enabled_path):
            enabled = await self._is_runtime_enabled()
            if enabled:
                await self.activate(reason="config_enabled")
            else:
                await self.deactivate(reason="config_disabled")
            return

        if self._runtime_state == "active":
            await self.reload_config(event)
        else:
            log_debug(f"{self.module} ignored config reload while {self._runtime_state}")

    async def reload_config(self, event: Any) -> None:
        """Reload service config from a full ConfigChangedEvent.

        Kept separate from reload(config_section) so services can override with
        exact key-path behavior while existing reload implementations continue
        to work.
        """
        section = event.affected_sections[0] if event.affected_sections else None
        if section is None and event.key_path:
            section = event.key_path.split(".", 1)[0]
        await self.reload(section)

    def _event_matches_enabled_path(self, key_path: str, enabled_path: str) -> bool:
        if key_path == enabled_path:
            return True
        return enabled_path.startswith(f"{key_path}.")

    def _enabled_config_path(self) -> str | None:
        """Return the lifecycle-authoritative enabled config path for this module."""
        if self.module == "Config":
            return None
        from app.shared.config.keys import ConfigKeys

        paths = {
            "Auth": ConfigKeys.services.auth.enabled,
            "DB": ConfigKeys.services.db.enabled,
            "Gateway": ConfigKeys.services.gateway.enabled,
            "Orchestrator": ConfigKeys.services.orchestrator.enabled,
            "Scheduler": ConfigKeys.services.scheduler.enabled,
            "STTCoordinator": ConfigKeys.services.stt.coordinator.enabled,
            "Tooling": ConfigKeys.services.tooling.enabled,
            "Transcription": ConfigKeys.services.stt.transcription.enabled,
            "TTS": ConfigKeys.services.tts.enabled,
            "WakeWord": ConfigKeys.services.stt.wakeword.enabled,
        }
        path = paths.get(self.module)
        return str(path) if path is not None else None

    async def _is_runtime_enabled(self) -> bool:
        """Read this service's enabled flag from ConfigService."""
        enabled_path = self._enabled_config_path()
        if enabled_path is None:
            return True
        try:
            from app.shared.config.interface import ConfigAPI

            enabled = await ConfigAPI().aget(enabled_path, default=True, config_timeout=20.0)
            return bool(enabled)
        except Exception as e:
            log_error(
                f"Failed to read enabled config for {self.module} at {enabled_path}: {e}; "
                "defaulting to enabled"
            )
            return True

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

        if self._contract_subscriptions:
            return

        for attr_name in dir(self):
            try:
                descriptor = inspect.getattr_static(self, attr_name, None)
                if isinstance(descriptor, property):
                    continue
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
                            pass_envelope=_wants_envelope(attr),  # noqa: B008
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
                                                    correlation_id=envelope.correlation_id,
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
                                            correlation_id=envelope.correlation_id,
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
                                            correlation_id=envelope.correlation_id,
                                        )

                            return wrapper

                        # Subscribe with the wrapper
                        handler = await create_wrapper()
                        self.bus.subscribe(topic, handler)
                        self._contract_subscriptions.append((topic, handler))
                        log_info(f"Auto-subscribed {attr_name} to {topic}")

            except Exception as e:
                log_error(f"Error setting up subscription for {attr_name}: {e}")

    def _unsubscribe_registered_contracts(self) -> None:
        """Unsubscribe all auto-registered method contracts."""
        for topic, handler in list(self._contract_subscriptions):
            try:
                self.bus.unsubscribe(topic, handler)
                log_debug(f"Unsubscribed {self.module} contract from {topic}")
            except Exception as e:
                log_error(f"Error unsubscribing {self.module} from {topic}: {e}")
        self._contract_subscriptions.clear()

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
        if not self._announce_to_gateway or self._runtime_state != "active":
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

    async def _publish_service_departure(self, reason: str = "shutdown") -> None:
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
                reason=reason,
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
        if not self._announce_to_gateway or self._runtime_state != "active":
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
