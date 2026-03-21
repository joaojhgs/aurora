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
            module=ConfigModule.NAME,
            summary="Configuration management service",
            capabilities=["config_management", "plugin_management"],
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
            await self.bus.publish(ConfigMethods.UPDATED, event, event=True, mesh=True)
            log_debug(f"Published config change event: {event.key_path}")
        except Exception as e:
            log_error(f"Failed to publish config change event: {e}")

    @method_contract(
        method_id=ConfigMethods.GET,
        summary="Get configuration value",
        input_model=GetConfigQuery,
        output_model=GetConfigResponse,
        exposure="both",
        method_type="use",
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
        method_type="manage",
    )
    async def _handle_update_config(self, cmd: UpdateConfigCommand) -> UpdateConfigResponse:
        """Handle UpdateConfig command."""
        try:
            self.config_manager.set(cmd.key_path, cmd.value)
            log_info(f"Updated config: {cmd.key_path}")
            return UpdateConfigResponse(success=True)
        except Exception as e:
            log_error(f"Error updating config: {e}")
            return UpdateConfigResponse(success=False, error=str(e))

    @method_contract(
        method_id=ConfigMethods.VALIDATE,
        summary="Validate current configuration",
        input_model=ValidateConfigQuery,
        output_model=ValidateConfigResponse,
        exposure="both",
        method_type="use",
    )
    async def _handle_validate_config(self, query: ValidateConfigQuery) -> ValidateConfigResponse:
        """Handle ValidateConfig query."""
        errors = self.config_manager.validate_current_config()
        log_debug(f"Handled ValidateConfig query: {len(errors)} errors")
        return ValidateConfigResponse(errors=errors)

    @method_contract(
        method_id=ConfigMethods.GET_PLUGIN,
        summary="Get plugin status",
        input_model=GetPluginStatusQuery,
        output_model=GetPluginStatusResponse,
        exposure="both",
        method_type="use",
    )
    async def _handle_get_plugin_status(
        self, query: GetPluginStatusQuery
    ) -> GetPluginStatusResponse:
        """Handle GetPluginStatus query."""
        active = self.config_manager.get(f"plugins.{query.plugin_name}.activate", False)
        log_debug(f"Handled GetPluginStatus query: {query.plugin_name}={active}")
        return GetPluginStatusResponse(active=active)

    @method_contract(
        method_id=ConfigMethods.SET_PLUGIN,
        summary="Update plugin status",
        input_model=UpdatePluginStatusCommand,
        output_model=UpdateConfigResponse,
        exposure="both",
        method_type="manage",
    )
    async def _handle_update_plugin_status(
        self, cmd: UpdatePluginStatusCommand
    ) -> UpdateConfigResponse:
        """Handle UpdatePluginStatus command."""
        try:
            self.config_manager.set(f"plugins.{cmd.plugin_name}.activate", cmd.active)
            log_info(f"Updated plugin status: {cmd.plugin_name}={cmd.active}")
            return UpdateConfigResponse(success=True)
        except Exception as e:
            log_error(f"Error updating plugin status: {e}")
            return UpdateConfigResponse(success=False, error=str(e))

    @method_contract(
        method_id=ConfigMethods.RELOAD_SERVICE,
        summary="Reload a service",
        input_model=ReloadServiceCommand,
        output_model=EmptyOutput,
        exposure="internal",
        method_type="manage",
    )
    async def _handle_reload_service(self, cmd: ReloadServiceCommand) -> EmptyOutput:
        """Handle ReloadService command."""
        # Publish reload event for the service
        # In threads mode, supervisor will handle reload
        # In processes mode, service will handle its own reload
        log_info(f"Reload service requested: {cmd.service_name} (reason: {cmd.reason})")
        # The service will subscribe to Config.Changed events and reload itself
        return EmptyOutput()

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
