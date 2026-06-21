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
from app.shared.contracts.models.config import (
    ConfigDiffPreviewRequest,
    ConfigDiffPreviewResponse,
    ConfigMethods,
    ConfigModule,
    ConfigReloadImpactRequest,
    ConfigReloadImpactResponse,
    ConfigRollbackRequest,
    ConfigRollbackResponse,
    ConfigSchemaMetadataRequest,
    ConfigSchemaMetadataResponse,
    ConfigVersionHistoryRequest,
    ConfigVersionHistoryResponse,
)
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
            metadata = self.config_manager.set(cmd.key_path, cmd.value)
            log_info(f"Updated config: {cmd.key_path}")
            return UpdateConfigResponse(success=True, **metadata)
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
        method_id=ConfigMethods.GET_SCHEMA_METADATA,
        summary="Get UI-readable config schema metadata",
        input_model=ConfigSchemaMetadataRequest,
        output_model=ConfigSchemaMetadataResponse,
        exposure="both",
        method_type="use",
        required_perms=[ConfigMethods.GET_SCHEMA_METADATA],
    )
    async def _handle_get_schema_metadata(
        self, query: ConfigSchemaMetadataRequest
    ) -> ConfigSchemaMetadataResponse:
        """Handle schema metadata query with secret values redacted."""
        fields = self.config_manager.get_schema_metadata(
            section=query.section,
            include_values=query.include_values,
        )
        return ConfigSchemaMetadataResponse(fields=fields, secrets_redacted=True)

    @method_contract(
        method_id=ConfigMethods.PREVIEW_DIFF,
        summary="Preview a validated config diff without writing changes",
        input_model=ConfigDiffPreviewRequest,
        output_model=ConfigDiffPreviewResponse,
        exposure="both",
        method_type="use",
        required_perms=[ConfigMethods.PREVIEW_DIFF],
    )
    async def _handle_preview_diff(
        self, query: ConfigDiffPreviewRequest
    ) -> ConfigDiffPreviewResponse:
        """Handle dry-run config diff preview."""
        result = self.config_manager.preview_diff([change.model_dump() for change in query.changes])
        return ConfigDiffPreviewResponse(**result)

    @method_contract(
        method_id=ConfigMethods.GET_VERSION_HISTORY,
        summary="Get recent redacted config version history",
        input_model=ConfigVersionHistoryRequest,
        output_model=ConfigVersionHistoryResponse,
        exposure="both",
        method_type="use",
        required_perms=[ConfigMethods.GET_VERSION_HISTORY],
    )
    async def _handle_get_version_history(
        self, query: ConfigVersionHistoryRequest
    ) -> ConfigVersionHistoryResponse:
        """Handle config version history query."""
        versions = self.config_manager.get_version_history(
            key_path=query.key_path,
            limit=query.limit,
        )
        return ConfigVersionHistoryResponse(versions=versions, secrets_redacted=True)

    @method_contract(
        method_id=ConfigMethods.ROLLBACK,
        summary="Rollback a config value to a previous version",
        input_model=ConfigRollbackRequest,
        output_model=ConfigRollbackResponse,
        exposure="both",
        method_type="manage",
        required_perms=[ConfigMethods.ROLLBACK],
    )
    async def _handle_rollback(self, cmd: ConfigRollbackRequest) -> ConfigRollbackResponse:
        """Handle config rollback command."""
        try:
            result = self.config_manager.rollback(cmd.version_id)
            log_info(f"Rolled back config version: {cmd.version_id}")
            return ConfigRollbackResponse(**result)
        except Exception as e:
            log_error(f"Error rolling back config version {cmd.version_id}: {e}")
            return ConfigRollbackResponse(success=False, error=str(e))

    @method_contract(
        method_id=ConfigMethods.PREVIEW_RELOAD_IMPACT,
        summary="Preview reload and restart impact for config paths",
        input_model=ConfigReloadImpactRequest,
        output_model=ConfigReloadImpactResponse,
        exposure="both",
        method_type="use",
        required_perms=[ConfigMethods.PREVIEW_RELOAD_IMPACT],
    )
    async def _handle_preview_reload_impact(
        self, query: ConfigReloadImpactRequest
    ) -> ConfigReloadImpactResponse:
        """Handle config reload/restart impact preview."""
        key_paths = list(query.key_paths)
        key_paths.extend(change.key_path for change in query.changes)
        impacts = self.config_manager.get_reload_impact(sorted(set(key_paths)))
        return ConfigReloadImpactResponse(impacts=impacts)

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
        active = self.config_manager.get(
            f"services.tooling.plugins.{query.plugin_name}.activate", False
        )
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
            metadata = self.config_manager.set(
                f"services.tooling.plugins.{cmd.plugin_name}.activate", cmd.active
            )
            log_info(f"Updated plugin status: {cmd.plugin_name}={cmd.active}")
            return UpdateConfigResponse(success=True, **metadata)
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
        log_debug(f"Ignoring ConfigService self-reload request: section={config_section}")
