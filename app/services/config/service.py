"""Config Service for Aurora's configuration management.

This service:
- Handles configuration queries and updates via message bus
- Manages config observers and change notifications
- Publishes config change events
- Supports config reload mechanism
"""

from __future__ import annotations

from typing import Any

from app.helpers.aurora_logger import log_debug, log_error, log_info
from app.messaging import Command, Envelope, Event, MessageBus, Query, QueryResult
from app.services.config.config_manager import ConfigManager
from app.services.config.messages import (
    ConfigChangedEvent,
    GetConfigQuery,
    GetConfigResponse,
    GetPluginStatusQuery,
    GetPluginStatusResponse,
    ReloadServiceCommand,
    UpdateConfigCommand,
    UpdateConfigResponse,
    UpdatePluginStatusCommand,
    ValidateConfigQuery,
    ValidateConfigResponse,
)
from app.shared.contracts.models.common import EmptyOutput
from app.shared.contracts.models.config import ConfigMethods, ConfigModule
from app.shared.contracts.registry import method_contract
from app.shared.services.base_service import BaseService


class ConfigService(BaseService):
    """Config Service for managing Aurora configuration."""

    def __init__(self):
        """Initialize the config service."""
        super().__init__(
            module=ConfigModule.NAME, summary="Configuration management service", capabilities=["config_management", "plugin_management"]
        )
        self.config_manager = ConfigManager()
        self._setup_config_observers()

    def _setup_config_observers(self) -> None:
        """Set up config observers to publish change events."""

        def on_config_change(key_path: str, old_value: Any, new_value: Any) -> None:
            """Handle config change and publish event."""
            # Determine affected sections
            affected_sections = []
            if key_path:
                parts = key_path.split(".")
                if len(parts) > 0:
                    affected_sections.append(parts[0])
                    # Add parent sections
                    for i in range(1, len(parts)):
                        affected_sections.append(".".join(parts[: i + 1]))

            # Publish config change event
            try:
                event = ConfigChangedEvent(
                    affected_sections=affected_sections,
                    key_path=key_path,
                    old_value=old_value,
                    new_value=new_value,
                )
                # Use asyncio to publish event
                import asyncio

                try:
                    loop = asyncio.get_event_loop()
                    if loop.is_running():
                        asyncio.create_task(self._publish_config_change(event))
                    else:
                        loop.run_until_complete(self._publish_config_change(event))
                except RuntimeError:
                    # No event loop, create task in background
                    asyncio.run(self._publish_config_change(event))
            except Exception as e:
                log_error(f"Failed to publish config change event: {e}")

        # Register observer with config manager
        self.config_manager.add_observer(on_config_change)

    async def _publish_config_change(self, event: ConfigChangedEvent) -> None:
        """Publish config change event to bus."""
        try:
            await self.bus.publish(ConfigMethods.UPDATED, event, event=True)
            log_debug(f"Published config change event: {event.key_path}")
        except Exception as e:
            log_error(f"Failed to publish config change event: {e}")

    @method_contract(
        method_id=ConfigMethods.GET, summary="Get configuration value", input_model=GetConfigQuery, output_model=GetConfigResponse, exposure="both"
    )
    async def _handle_get_config(self, query: GetConfigQuery) -> GetConfigResponse:
        """Handle GetConfig query.

        Args:
            query: GetConfigQuery (payload already extracted by base_service wrapper)

            Returns:
                GetConfigResponse (automatically published to reply_to by base_service wrapper)
        """
        try:
            section = query.section

            # Log the request with debug details (only shown when AURORA_DEBUG_LOGS=true)
            log_debug(f"[GetConfig] section='{section}'")

            if section:
                config = self.config_manager.get(section, {})
            else:
                config = self.config_manager.get_config_dict()

            response = GetConfigResponse(config=config)
            return response
        except Exception as e:
            log_error(f"Error handling GetConfig query: {e}", exc_info=True)
            # Return empty config on error
            return GetConfigResponse(config={})

    @method_contract(
        method_id=ConfigMethods.SET,
        summary="Update configuration value",
        input_model=UpdateConfigCommand,
        output_model=UpdateConfigResponse,
        exposure="both",
    )
    async def _handle_update_config(self, envelope: Envelope) -> None:
        """Handle UpdateConfig command."""
        try:
            command = envelope.payload
            if not isinstance(command, UpdateConfigCommand):
                log_error(f"Invalid payload type for UpdateConfig: {type(command)}")
                return

            try:
                self.config_manager.set(command.key_path, command.value)
                response = UpdateConfigResponse(success=True)
                log_info(f"Updated config: {command.key_path}")
            except Exception as e:
                response = UpdateConfigResponse(success=False, error=str(e))
                log_error(f"Error updating config: {e}")

            if envelope.reply_to:
                await self.bus.publish(envelope.reply_to, response, event=False)
        except Exception as e:
            log_error(f"Error handling UpdateConfig command: {e}")

    @method_contract(
        method_id=ConfigMethods.VALIDATE,
        summary="Validate current configuration",
        input_model=ValidateConfigQuery,
        output_model=ValidateConfigResponse,
        exposure="both",
    )
    async def _handle_validate_config(self, envelope: Envelope) -> None:
        """Handle ValidateConfig query."""
        try:
            errors = self.config_manager.validate_current_config()
            response = ValidateConfigResponse(errors=errors)
            await self.bus.publish(envelope.reply_to, response, event=False)
            log_debug(f"Handled ValidateConfig query: {len(errors)} errors")
        except Exception as e:
            log_error(f"Error handling ValidateConfig query: {e}")

    @method_contract(
        method_id=ConfigMethods.GET_PLUGIN,
        summary="Get plugin status",
        input_model=GetPluginStatusQuery,
        output_model=GetPluginStatusResponse,
        exposure="both",
    )
    async def _handle_get_plugin_status(self, envelope: Envelope) -> None:
        """Handle GetPluginStatus query."""
        try:
            query = envelope.payload
            if not isinstance(query, GetPluginStatusQuery):
                log_error(f"Invalid payload type for GetPluginStatus: {type(query)}")
                return

            active = self.config_manager.get(f"plugins.{query.plugin_name}.activate", False)
            response = GetPluginStatusResponse(active=active)
            await self.bus.publish(envelope.reply_to, response, event=False)
            log_debug(f"Handled GetPluginStatus query: {query.plugin_name}={active}")
        except Exception as e:
            log_error(f"Error handling GetPluginStatus query: {e}")

    @method_contract(
        method_id=ConfigMethods.SET_PLUGIN,
        summary="Update plugin status",
        input_model=UpdatePluginStatusCommand,
        output_model=UpdateConfigResponse,
        exposure="both",
    )
    async def _handle_update_plugin_status(self, envelope: Envelope) -> None:
        """Handle UpdatePluginStatus command."""
        try:
            command = envelope.payload
            if not isinstance(command, UpdatePluginStatusCommand):
                log_error(f"Invalid payload type for UpdatePluginStatus: {type(command)}")
                return

            try:
                self.config_manager.set(f"plugins.{command.plugin_name}.activate", command.active)
                response = UpdateConfigResponse(success=True)
                log_info(f"Updated plugin status: {command.plugin_name}={command.active}")
            except Exception as e:
                response = UpdateConfigResponse(success=False, error=str(e))
                log_error(f"Error updating plugin status: {e}")

            if envelope.reply_to:
                await self.bus.publish(envelope.reply_to, response, event=False)
        except Exception as e:
            log_error(f"Error handling UpdatePluginStatus command: {e}")

    @method_contract(
        method_id=ConfigMethods.RELOAD_SERVICE,
        summary="Reload a service",
        input_model=ReloadServiceCommand,
        output_model=EmptyOutput,
        exposure="internal",
    )
    async def _handle_reload_service(self, envelope: Envelope) -> None:
        """Handle ReloadService command."""
        try:
            command = envelope.payload
            if not isinstance(command, ReloadServiceCommand):
                log_error(f"Invalid payload type for ReloadService: {type(command)}")
                return

            # Publish reload event for the service
            # In threads mode, supervisor will handle reload
            # In processes mode, service will handle its own reload
            log_info(f"Reload service requested: {command.service_name} (reason: {command.reason})")
            # The service will subscribe to Config.Changed events and reload itself
        except Exception as e:
            log_error(f"Error handling ReloadService command: {e}")

    async def on_start(self) -> None:
        """Start the config service."""
        log_info("Starting ConfigService...")

        # Note: Subscriptions are now handled automatically by BaseService via @method_contract

        # Subscribe to config changes for reload mechanism
        self._subscribe_to_config_changes()

        self._set_started(True)
        log_info("ConfigService started")

    async def on_stop(self) -> None:
        """Stop the config service."""
        log_info("Stopping ConfigService...")
        self._set_started(False)
        log_info("ConfigService stopped")

    async def reload(self, config_section: str | None = None) -> None:
        """Reload service configuration.

        Args:
            config_section: The configuration section that changed (None = full reload)
        """
        log_info(f"Reloading ConfigService configuration: section={config_section}")
        # Config service doesn't need to reload itself, but we can reload the config file
        self.config_manager.load_config()
        log_info("ConfigService configuration reloaded")
