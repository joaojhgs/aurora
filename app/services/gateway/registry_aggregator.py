"""Registry Aggregator for collecting service registries.

This module provides an abstraction layer for registry access that works in:
- Thread mode: Direct access to shared in-memory registry
- Process mode (managed): Query known services + listen for announcements
- Process mode (Docker): Must rely on service announcements only
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.shared.contracts.models.gateway import (
    GatewayMethods,
    MethodInfo,
    ServiceAnnouncement,
    ServiceDeparture,
    ServiceHeartbeat,
    ServiceInfo,
)

if TYPE_CHECKING:
    from app.messaging.bus import MessageBus


class RegistryAggregator:
    """Aggregates service registries from multiple sources.

    In thread mode, directly queries the in-process registry.
    In process mode, maintains state from service announcements.
    """

    def __init__(
        self,
        bus: MessageBus,
        mode: str = "threads",
        heartbeat_timeout_s: float = 90.0,
    ):
        """Initialize the registry aggregator.

        Args:
            bus: Message bus instance
            mode: Architecture mode ("threads" or "processes")
            heartbeat_timeout_s: How long before marking a service stale (no heartbeat)
        """
        self._bus = bus
        self._mode = mode
        self._heartbeat_timeout = timedelta(seconds=heartbeat_timeout_s)

        # Aggregated service registries (module_name -> ServiceAnnouncement)
        self._services: dict[str, ServiceAnnouncement] = {}

        # Last seen timestamps for health tracking
        self._last_seen: dict[str, datetime] = {}

        # Lock for thread-safe access
        self._lock = asyncio.Lock()

        # Whether we've subscribed to announcements
        self._subscribed = False
        self._expiry_task: asyncio.Task | None = None

        # Callback for registry changes (used by route generator)
        self._on_change_callbacks: list[Callable] = []

    async def start(self) -> None:
        """Start the registry aggregator.

        Subscribes to service announcements and performs initial discovery.
        """
        if self._subscribed:
            return

        # Subscribe to service announcements
        self._bus.subscribe(GatewayMethods.SERVICE_ANNOUNCE, self._on_service_announce)
        self._bus.subscribe(GatewayMethods.SERVICE_DEPART, self._on_service_depart)
        self._bus.subscribe(GatewayMethods.SERVICE_HEARTBEAT, self._on_service_heartbeat)

        self._subscribed = True
        log_info(f"RegistryAggregator started in {self._mode} mode")

        # In thread mode, also load from in-process registry
        if self._mode == "threads":
            await self._load_from_local_registry()
        else:
            self._expiry_task = asyncio.create_task(self._stale_expiry_loop())

    async def stop(self) -> None:
        """Stop the registry aggregator."""
        if self._subscribed:
            self._bus.unsubscribe(GatewayMethods.SERVICE_ANNOUNCE, self._on_service_announce)
            self._bus.unsubscribe(GatewayMethods.SERVICE_DEPART, self._on_service_depart)
            self._bus.unsubscribe(GatewayMethods.SERVICE_HEARTBEAT, self._on_service_heartbeat)
        if self._expiry_task:
            self._expiry_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._expiry_task
            self._expiry_task = None
        self._subscribed = False
        log_info("RegistryAggregator stopped")

    def on_registry_change(self, callback: Callable) -> None:
        """Register a callback for registry changes.

        Args:
            callback: Async function called when registry changes
        """
        if callback not in self._on_change_callbacks:
            self._on_change_callbacks.append(callback)

    async def _notify_change(self) -> None:
        """Notify all callbacks of registry change."""
        for callback in self._on_change_callbacks:
            try:
                if asyncio.iscoroutinefunction(callback):
                    await callback()
                else:
                    callback()
            except Exception as e:
                log_error(f"Error in registry change callback: {e}")

    async def _load_from_local_registry(self) -> None:
        """Load services from the local in-process registry (thread mode only)."""
        try:
            from app.shared.contracts.registry import list_modules

            modules = list_modules()

            async with self._lock:
                for module_name, module_contract in modules.items():
                    # Convert to ServiceAnnouncement with schemas
                    methods = []
                    for m in module_contract.methods:
                        # Extract JSON schemas from Pydantic models
                        input_schema = None
                        output_schema = None

                        if m.input_model is not None:
                            with contextlib.suppress(Exception):
                                input_schema = m.input_model.model_json_schema()

                        if m.output_model is not None:
                            with contextlib.suppress(Exception):
                                output_schema = m.output_model.model_json_schema()

                        methods.append(
                            MethodInfo(
                                name=m.name,
                                summary=m.summary,
                                bus_topic=m.bus_topic,
                                exposure=m.exposure,
                                input_model=m.input_model.__name__ if m.input_model else None,
                                output_model=m.output_model.__name__ if m.output_model else None,
                                required_perms=m.required_perms,
                                method_type=m.method_type,
                                input_schema=input_schema,
                                output_schema=output_schema,
                            )
                        )

                    announcement = ServiceAnnouncement(
                        module=module_name,
                        version=module_contract.version,
                        summary=module_contract.summary,
                        capabilities=module_contract.capabilities,
                        methods=methods,
                    )

                    self._services[module_name] = announcement
                    self._last_seen[module_name] = datetime.utcnow()

            log_info(f"Loaded {len(self._services)} services from local registry")

        except Exception as e:
            log_error(f"Error loading from local registry: {e}")

    async def _on_service_announce(self, envelope: Any) -> None:
        """Handle service announcement."""
        try:
            payload = envelope.payload
            if isinstance(payload, dict):
                announcement = ServiceAnnouncement.model_validate(payload)
            elif isinstance(payload, ServiceAnnouncement):
                announcement = payload
            else:
                log_warning(f"Invalid announcement payload type: {type(payload)}")
                return

            module_name = announcement.module

            async with self._lock:
                old_announcement = self._services.get(module_name)
                self._services[module_name] = announcement
                self._last_seen[module_name] = datetime.utcnow()

            # Log and notify
            if old_announcement is None:
                log_info(
                    f"Service announced: {module_name} v{announcement.version} "
                    f"({len(announcement.methods)} methods)"
                )
            else:
                log_debug(f"Service re-announced: {module_name}")

            await self._notify_change()

        except Exception as e:
            log_error(f"Error handling service announcement: {e}")

    async def _on_service_depart(self, envelope: Any) -> None:
        """Handle service departure."""
        try:
            payload = envelope.payload
            if isinstance(payload, dict):
                departure = ServiceDeparture.model_validate(payload)
            elif isinstance(payload, ServiceDeparture):
                departure = payload
            else:
                log_warning(f"Invalid departure payload type: {type(payload)}")
                return

            module_name = departure.module

            async with self._lock:
                if module_name in self._services:
                    del self._services[module_name]
                if module_name in self._last_seen:
                    del self._last_seen[module_name]

            log_info(f"Service departed: {module_name} (reason: {departure.reason})")
            await self._notify_change()

        except Exception as e:
            log_error(f"Error handling service departure: {e}")

    async def _on_service_heartbeat(self, envelope: Any) -> None:
        """Handle service heartbeat."""
        try:
            payload = envelope.payload
            if isinstance(payload, dict):
                heartbeat = ServiceHeartbeat.model_validate(payload)
            elif isinstance(payload, ServiceHeartbeat):
                heartbeat = payload
            else:
                return

            module_name = heartbeat.module

            async with self._lock:
                if module_name in self._services:
                    self._last_seen[module_name] = datetime.utcnow()
                    log_debug(f"Heartbeat from: {module_name}")

        except Exception as e:
            log_error(f"Error handling heartbeat: {e}")

    async def _stale_expiry_loop(self) -> None:
        """Periodically remove services that stopped announcing without departure."""
        interval = max(5.0, self._heartbeat_timeout.total_seconds() / 3)
        try:
            while True:
                await asyncio.sleep(interval)
                await self.prune_stale_services()
        except asyncio.CancelledError:
            pass

    async def prune_stale_services(self) -> list[str]:
        """Remove services older than twice the heartbeat timeout."""
        if self._mode == "threads":
            return []

        now = datetime.utcnow()
        expired: list[str] = []

        async with self._lock:
            for module_name, last_seen in list(self._last_seen.items()):
                if now - last_seen >= self._heartbeat_timeout * 2:
                    expired.append(module_name)
                    self._last_seen.pop(module_name, None)
                    self._services.pop(module_name, None)

        if expired:
            log_warning(f"Expired stale service registrations: {', '.join(sorted(expired))}")
            await self._notify_change()
        return expired

    async def get_services(self) -> list[ServiceInfo]:
        """Get list of known services with their status.

        Returns:
            List of ServiceInfo objects
        """
        now = datetime.utcnow()
        services = []

        async with self._lock:
            for module_name, announcement in self._services.items():
                last_seen = self._last_seen.get(module_name, now)

                # In thread mode, services are always healthy if registered
                # (no heartbeat mechanism, all services in same process)
                if self._mode == "threads":
                    status = "healthy"
                else:
                    # In process mode, determine status based on last seen time
                    age = now - last_seen
                    if age < self._heartbeat_timeout:
                        status = "healthy"
                    elif age < self._heartbeat_timeout * 2:
                        status = "degraded"
                    else:
                        status = "unhealthy"

                services.append(
                    ServiceInfo(
                        module=module_name,
                        version=announcement.version,
                        summary=announcement.summary,
                        capabilities=announcement.capabilities,
                        method_count=len(announcement.methods),
                        last_seen=last_seen.isoformat(),
                        status=status,
                        instance_id=announcement.instance_id,
                    )
                )

        return services

    async def get_service(self, module_name: str) -> ServiceAnnouncement | None:
        """Get a specific service's announcement.

        Args:
            module_name: Name of the service module

        Returns:
            ServiceAnnouncement if found, None otherwise
        """
        async with self._lock:
            return self._services.get(module_name)

    async def get_external_methods(self) -> list[tuple[str, MethodInfo]]:
        """Get all methods that are exposed externally.

        Returns:
            List of (module_name, MethodInfo) tuples for external methods
        """
        external_methods = []

        async with self._lock:
            for module_name, announcement in self._services.items():
                for method in announcement.methods:
                    if method.exposure in ("external", "both"):
                        external_methods.append((module_name, method))

        return external_methods

    async def get_registry_export(self) -> dict[str, Any]:
        """Export the aggregated registry as a dictionary.

        Returns:
            Dictionary representation of the registry
        """
        import hashlib
        import json

        from app.shared.contracts.models.gateway import ModuleRegistryInfo

        modules_data: list[ModuleRegistryInfo] = []

        async with self._lock:
            for module_name, announcement in self._services.items():
                module_info = ModuleRegistryInfo(
                    module=module_name,
                    version=announcement.version,
                    summary=announcement.summary,
                    capabilities=announcement.capabilities,
                    methods=announcement.methods,
                )
                modules_data.append(module_info)

        # Calculate digest from stable JSON representation
        stable_json = json.dumps(
            [m.model_dump() for m in modules_data],
            sort_keys=True,
            separators=(",", ":"),
        )
        digest = hashlib.sha256(stable_json.encode()).hexdigest()

        return {
            "modules": modules_data,
            "digest": digest,
            "service_count": len(modules_data),
            "method_count": sum(len(m.methods) for m in modules_data),
        }

    async def refresh_from_local(self) -> None:
        """Refresh from local registry (thread mode).

        Called when services start/stop in thread mode.
        """
        if self._mode == "threads":
            await self._load_from_local_registry()
            await self._notify_change()

    def is_service_available(self, module_name: str) -> bool:
        """Check if a service is available (non-blocking).

        Args:
            module_name: Name of the service module

        Returns:
            True if service is registered and not stale
        """
        if module_name not in self._services:
            return False

        # In thread mode, services are in the same process and don't need
        # heartbeat-based health checks - just check if they're registered
        if self._mode == "threads":
            return True

        # In process mode, check last_seen for heartbeat-based health
        last_seen = self._last_seen.get(module_name)
        if last_seen is None:
            return False

        age = datetime.utcnow() - last_seen
        return age < self._heartbeat_timeout * 2

    def snapshot_services(self) -> dict[str, ServiceAnnouncement]:
        """Return a shallow copy of the internal services dict.

        This is safe to call from synchronous code (e.g. manifest
        generation).  The returned dict is a snapshot — mutations to it
        won't affect the aggregator.
        """
        return dict(self._services)
