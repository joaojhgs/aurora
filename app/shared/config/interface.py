"""Config API interface for all services.

This module provides ConfigAPI, a drop-in replacement for the old config_api.
It uses the message bus under the hood to communicate with the ConfigService.
"""

from __future__ import annotations

from typing import Any

from app.helpers.aurora_logger import log_error
from app.messaging.service_topics import ConfigTopics
from app.services.config.messages import (
    GetConfigQuery,
    GetPluginStatusQuery,
    UpdateConfigCommand,
    UpdatePluginStatusCommand,
    ValidateConfigQuery,
)
from app.shared.messaging.bus_init import get_bus_singleton


class ConfigAPI:
    """API for runtime configuration changes via message bus."""

    def __init__(self):
        """Initialize ConfigAPI."""
        self._bus = None

    @property
    def bus(self):
        """Get the message bus instance (lazy initialization)."""
        if self._bus is None:
            try:
                self._bus = get_bus_singleton()
            except RuntimeError:
                # Fallback: try to initialize bus
                from app.shared.messaging.bus_init import initialize_bus_for_service

                self._bus = initialize_bus_for_service("ConfigAPI")
        return self._bus

    def get_config(self, section: str = None) -> dict[str, Any]:
        """Get entire config or specific section.

        Args:
            section: Optional section name to get

        Returns:
            Configuration dictionary
        """
        try:
            import asyncio

            query = GetConfigQuery(section=section)
            result = asyncio.run(self.bus.request(ConfigTopics.GET_CONFIG, query, timeout=5.0))

            if result.ok and result.data:
                # Extract config from response
                if hasattr(result.data, "config"):
                    return result.data.config
                return result.data
            else:
                log_error(f"Error getting config: {result.error}")
                return {}
        except RuntimeError as e:
            log_error(f"Bus not initialized: {e}")
            return {}
        except Exception as e:
            log_error(f"Error getting config: {e}")
            return {}

    def get(self, key_path: str, default: Any = None) -> Any:
        """Get configuration value using dot notation (e.g., 'ui.activate').

        This method provides backward compatibility with config_manager.get().

        Args:
            key_path: Configuration key path (e.g., 'llm.provider')
            default: Default value if key not found

        Returns:
            Configuration value or default
        """
        try:
            # Get the full config
            config = self.get_config()
            
            # Navigate to the value using dot notation
            keys = key_path.split(".")
            value = config
            
            for k in keys:
                if isinstance(value, dict):
                    value = value.get(k)
                    if value is None:
                        return default
                else:
                    return default
            
            return value if value is not None else default
        except Exception as e:
            log_error(f"Error getting config value: {e}")
            return default

    def get_config_dict(self) -> dict[str, Any]:
        """Get a copy of the entire configuration dictionary.

        Returns:
            Configuration dictionary
        """
        return self.get_config()

    def get_section(self, section_path: str, default: Any = None) -> Any:
        """Get an entire configuration section using dot notation.

        This method provides backward compatibility with config_manager.get_section().

        Args:
            section_path: Configuration section path (e.g., 'llm.third_party.openai.options')
            default: Default value if section not found

        Returns:
            Configuration section dictionary or default
        """
        return self.get(section_path, default)

    def update_config(self, key_path: str, value: Any) -> bool:
        """Update a specific configuration value.

        Args:
            key_path: Configuration key path (e.g., "llm.provider")
            value: New value

        Returns:
            True if successful, False otherwise
        """
        try:
            import asyncio

            command = UpdateConfigCommand(key_path=key_path, value=value)
            result = asyncio.run(self.bus.request(ConfigTopics.UPDATE_CONFIG, command, timeout=5.0))

            if result.ok and result.data:
                if hasattr(result.data, "success"):
                    return result.data.success
                return True
            else:
                log_error(f"Error updating config: {result.error}")
                return False
        except RuntimeError as e:
            log_error(f"Bus not initialized: {e}")
            return False
        except Exception as e:
            log_error(f"Error updating config: {e}")
            return False

    def update_plugin_status(self, plugin_name: str, active: bool) -> bool:
        """Enable/disable a plugin.

        Args:
            plugin_name: Name of the plugin
            active: Whether to enable the plugin

        Returns:
            True if successful, False otherwise
        """
        try:
            import asyncio

            command = UpdatePluginStatusCommand(plugin_name=plugin_name, active=active)
            result = asyncio.run(self.bus.request(ConfigTopics.UPDATE_PLUGIN_STATUS, command, timeout=5.0))

            if result.ok and result.data:
                if hasattr(result.data, "success"):
                    return result.data.success
                return True
            else:
                log_error(f"Error updating plugin status: {result.error}")
                return False
        except RuntimeError as e:
            log_error(f"Bus not initialized: {e}")
            return False
        except Exception as e:
            log_error(f"Error updating plugin status: {e}")
            return False

    def get_plugin_status(self, plugin_name: str) -> bool:
        """Check if a plugin is active.

        Args:
            plugin_name: Name of the plugin

        Returns:
            True if plugin is active, False otherwise
        """
        try:
            import asyncio

            query = GetPluginStatusQuery(plugin_name=plugin_name)
            result = asyncio.run(self.bus.request(ConfigTopics.GET_PLUGIN_STATUS, query, timeout=5.0))

            if result.ok and result.data:
                if hasattr(result.data, "active"):
                    return result.data.active
                return False
            else:
                log_error(f"Error getting plugin status: {result.error}")
                return False
        except RuntimeError as e:
            log_error(f"Bus not initialized: {e}")
            return False
        except Exception as e:
            log_error(f"Error getting plugin status: {e}")
            return False

    def validate_config(self) -> list[str]:
        """Validate current configuration.

        Returns:
            List of validation errors (empty if valid)
        """
        try:
            import asyncio

            query = ValidateConfigQuery()
            result = asyncio.run(self.bus.request(ConfigTopics.VALIDATE_CONFIG, query, timeout=5.0))

            if result.ok and result.data:
                if hasattr(result.data, "errors"):
                    return result.data.errors
                return []
            else:
                log_error(f"Error validating config: {result.error}")
                return [result.error] if result.error else []
        except RuntimeError as e:
            log_error(f"Bus not initialized: {e}")
            return []
        except Exception as e:
            log_error(f"Error validating config: {e}")
            return []

    def migrate_from_env(self):
        """Migrate existing environment variables to config.json.

        This method directly accesses the ConfigManager for administrative operations.
        """
        try:
            from app.services.config.config_manager import ConfigManager

            config_manager = ConfigManager()
            config_manager.migrate_from_env()
        except Exception as e:
            log_error(f"Error migrating from environment: {e}")

    def add_config_observer(self, callback):
        """Add observer for configuration changes.

        Args:
            callback: Callback function to call on config changes
        """
        try:
            # Subscribe to config change events
            async def on_config_changed(envelope):
                """Handle config change event."""
                payload = envelope.payload
                callback(
                    getattr(payload, "key_path", ""),
                    getattr(payload, "old_value", None),
                    getattr(payload, "new_value", None),
                )

            self.bus.subscribe(ConfigTopics.CHANGED, on_config_changed)
        except Exception as e:
            log_error(f"Error adding config observer: {e}")

    def remove_config_observer(self, callback):
        """Remove observer for configuration changes.

        Args:
            callback: Callback function to remove
        """
        # Note: Bus doesn't have a direct unsubscribe method
        # Observers are managed by the service that subscribes
        # This is a no-op for now, but can be enhanced if needed
        pass

    async def get_mcp_status(self) -> dict[str, Any]:
        """Get MCP system status via message bus.

        Returns:
            Dictionary containing MCP status
        """
        try:
            from app.messaging import ToolingTopics

            result = await self.bus.request(
                ToolingTopics.GET_MCP_STATUS,
                {},
                timeout=5.0,
            )
            if result.ok and result.data:
                return result.data
            else:
                return {"error": result.error or "Unknown error"}
        except RuntimeError as e:
            log_error(f"Bus not initialized: {e}")
            return {"error": "Bus not initialized"}
        except Exception as e:
            log_error(f"Error getting MCP status: {e}")
            return {"error": str(e)}

    async def reload_mcp_servers(self) -> dict[str, Any]:
        """Reload MCP servers from configuration via message bus.

        Returns:
            Dictionary containing reload result
        """
        try:
            from app.messaging import ToolingTopics
            from app.tooling.service import ReloadMCPToolsCommand

            await self.bus.publish(
                ToolingTopics.RELOAD_MCP_TOOLS,
                ReloadMCPToolsCommand(),
                event=False,
            )
            return {"success": True, "message": "MCP servers reload initiated"}
        except RuntimeError as e:
            log_error(f"Bus not initialized: {e}")
            return {"success": False, "error": "Bus not initialized"}
        except Exception as e:
            log_error(f"Error reloading MCP servers: {e}")
            return {"success": False, "error": str(e)}

    async def update_mcp_config(self, servers_config: dict[str, Any]) -> dict[str, Any]:
        """Update MCP servers configuration and reload via message bus.

        Args:
            servers_config: Dictionary of MCP server configurations

        Returns:
            Dictionary containing update result
        """
        try:
            # Update configuration
            success = self.update_config("mcp.servers", servers_config)
            if not success:
                return {"success": False, "error": "Failed to update config"}

            # Reload servers via bus
            from app.messaging import ToolingTopics
            from app.tooling.service import ReloadMCPToolsCommand

            await self.bus.publish(
                ToolingTopics.RELOAD_MCP_TOOLS,
                ReloadMCPToolsCommand(),
                event=False,
            )

            return {"success": True, "message": "MCP configuration updated and servers reloaded"}
        except RuntimeError as e:
            log_error(f"Bus not initialized: {e}")
            return {"success": False, "error": "Bus not initialized"}
        except Exception as e:
            log_error(f"Error updating MCP config: {e}")
            return {"success": False, "error": str(e)}

    def discover_mcp_servers(self) -> dict[str, Any]:
        """Discover MCP servers using various methods.

        Returns:
            Dictionary containing discovered servers
        """
        try:
            import asyncio

            from app.tooling.mcp.mcp_discovery import discover_mcp_servers

            # Run discovery
            discovered = asyncio.run(discover_mcp_servers())

            # Convert to serializable format
            servers_info = {}
            for key, server in discovered.items():
                servers_info[key] = {
                    "name": server.name,
                    "transport": server.transport,
                    "command": server.command,
                    "args": server.args,
                    "url": server.url,
                    "env": server.env,
                    "source": server.source,
                    "description": server.description,
                    "installed": server.installed,
                }

            return {"success": True, "servers": servers_info, "count": len(servers_info), "message": f"Discovered {len(servers_info)} MCP servers"}

        except Exception as e:
            log_error(f"Error discovering MCP servers: {e}")
            return {"success": False, "error": str(e)}

    async def add_discovered_servers_to_config(self, server_names: list[str] = None) -> dict[str, Any]:
        """Add discovered servers to Aurora's MCP configuration and reload via message bus.

        Args:
            server_names: Optional list of server names to add (None = all discovered)

        Returns:
            Dictionary containing add result
        """
        try:
            from app.tooling.mcp.mcp_discovery import mcp_discovery

            discovered = mcp_discovery.get_server_configs_for_aurora()

            # Filter by requested server names if provided
            if server_names:
                discovered = {name: config for name, config in discovered.items() if name in server_names}

            # Get current MCP config
            current_servers = self.get_config().get("mcp", {}).get("servers", {})

            # Merge with discovered servers
            updated_servers = current_servers.copy()
            updated_servers.update(discovered)

            # Update configuration
            success = self.update_config("mcp.servers", updated_servers)
            if not success:
                return {"success": False, "error": "Failed to update config"}

            # Reload servers via bus
            from app.messaging import ToolingTopics
            from app.tooling.service import ReloadMCPToolsCommand

            await self.bus.publish(
                ToolingTopics.RELOAD_MCP_TOOLS,
                ReloadMCPToolsCommand(),
                event=False,
            )

            return {
                "success": True,
                "added_servers": list(discovered.keys()),
                "total_servers": len(updated_servers),
                "message": f"Added {len(discovered)} discovered servers to configuration",
            }

        except RuntimeError as e:
            log_error(f"Bus not initialized: {e}")
            return {"success": False, "error": "Bus not initialized"}
        except Exception as e:
            log_error(f"Error adding discovered servers: {e}")
            return {"success": False, "error": str(e)}


# Global API instance (for backward compatibility)
config_api = ConfigAPI()
