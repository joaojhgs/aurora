"""Config API interface for all services.

This module provides ConfigAPI, a drop-in replacement for the old config_api.
It uses the message bus under the hood to communicate with the ConfigService.
"""

from __future__ import annotations

import warnings
from typing import Any, TypeVar, overload

from pydantic import BaseModel

from app.helpers.aurora_logger import log_debug, log_error, log_warning
from app.services.config.messages import (
    GetConfigQuery,
    GetPluginStatusQuery,
    UpdateConfigCommand,
    UpdatePluginStatusCommand,
    ValidateConfigQuery,
)
from app.shared.contracts.models.config import ConfigMethods
from app.shared.messaging.bus_init import get_bus_singleton

T = TypeVar("T", bound=BaseModel)


class ConfigAPI:
    """API for runtime configuration changes via message bus."""

    def __init__(self):
        """Initialize ConfigAPI.

        Note: Bus access is lazy - it won't be accessed until first use.
        This allows ConfigAPI to be instantiated before ConfigService is ready.
        """
        self._bus = None
        self._bus_initialized = False

    @property
    def bus(self):
        """Get the message bus instance (lazy initialization).

        This property is only accessed when actually making config requests,
        ensuring ConfigService is ready before we try to use the bus.

        Always verifies the cached reference matches the current global
        singleton so that stale bus references are transparently replaced
        (e.g. when the Supervisor creates a new bus after module-level
        ConfigAPI construction).
        """
        try:
            current = get_bus_singleton()
            if self._bus is not current:
                self._bus = current
            self._bus_initialized = True
        except RuntimeError:
            # Bus not ready yet - this is OK, we'll try again on first use
            if not self._bus_initialized:
                self._bus_initialized = True
            return self._bus  # may be None
        return self._bus

    def _ensure_bus(self):
        """Ensure bus is available, retrying if needed.

        Verifies the cached bus matches the current global singleton to
        avoid using a stale LocalBus created before the Supervisor.
        """
        try:
            current = get_bus_singleton()
            if self._bus is not current:
                self._bus = current
            return True
        except RuntimeError:
            pass

        if self._bus is not None:
            return True

        # Last resort: try to create a bus for this service
        from app.shared.messaging.bus_init import initialize_bus_for_service

        try:
            self._bus = initialize_bus_for_service("ConfigAPI")
        except Exception:
            return False
        return self._bus is not None

    def _is_config_service_ready(self) -> bool:
        """Check if ConfigService has registered its contracts.

        In **processes** mode each service only registers its own methods, so
        ``Config.Get`` never appears in this process's registry even when Config
        is healthy on Redis. Rely on the bus being up and use live requests instead.
        """
        import os

        mode = os.getenv("AURORA_ARCHITECTURE_MODE", "threads").lower()
        if mode == "processes":
            return bool(self._ensure_bus())

        try:
            from app.shared.contracts.registry import all_contracts

            contracts = all_contracts()
            # Check if Config.Get is registered
            return any(
                c.bus_topic == ConfigMethods.GET or c.name == ConfigMethods.GET
                for c in contracts.values()
            )
        except Exception:
            return False

    def get_config(self, section: str = None) -> dict[str, Any]:
        """Get entire config or specific section (sync version).

        Args:
            section: Optional section name to get

        Returns:
            Configuration dictionary
        """
        # Ensure bus is available
        if not self._ensure_bus():
            log_debug("Bus not available for config request. ConfigService may not be ready yet.")
            return {}

        # Check if ConfigService has registered its contracts
        if not self._is_config_service_ready():
            log_debug("ConfigService contracts not registered yet. Returning empty config.")
            return {}

        try:
            import asyncio

            query = GetConfigQuery(section=section)

            # Check if we're already in an async context
            try:
                asyncio.get_running_loop()
                log_error(
                    "get_config() called from async context. Use aget_config() or await bus.request() directly."
                )
                return {}
            except RuntimeError:
                result = asyncio.run(self.bus.request(ConfigMethods.GET, query, timeout=5.0))

            if result.ok and result.data:
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

    async def aget_config(self, section: str = None, *, timeout: float = 5.0) -> dict[str, Any]:
        """Get entire config or specific section (async version).

        Args:
            section: Optional section name to get
            timeout: Bus request timeout (seconds); use a higher value during cross-process
                startup when ConfigService may still be registering workers.

        Returns:
            Configuration dictionary
        """
        # Ensure bus is available
        if not self._ensure_bus():
            log_debug("Bus not available for config request. ConfigService may not be ready yet.")
            return {}

        # Check if ConfigService has registered its contracts
        if not self._is_config_service_ready():
            log_debug("ConfigService contracts not registered yet. Returning empty config.")
            return {}

        try:
            query = GetConfigQuery(section=section)
            result = await self.bus.request(ConfigMethods.GET, query, timeout=timeout)

            if result.ok and result.data:
                # Extract config from response
                if hasattr(result.data, "config"):
                    return result.data.config
                # Check if result.data is a dict with a 'config' key (wrapped response)
                if isinstance(result.data, dict) and "config" in result.data:
                    return result.data["config"]
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

    def get_app_config(self) -> Any:
        """Get the fully typed application configuration.

        This method retrieves the full configuration dictionary and parses it into
        the strongly-typed AppConfig model, returning defaults for missing fields.

        .. deprecated:: Use ``aget(ConfigKeys.services.section, SectionModel)`` instead.
        """
        from app.shared.config.models import Model as AppConfig

        config_dict = self.get("", default={})

        try:
            return AppConfig.model_validate(config_dict)
        except Exception as e:
            log_error(f"Failed to validate AppConfig from defaults: {e}")
            return AppConfig()

    @overload
    def get(self, key_path: str, model: type[T]) -> T: ...

    @overload
    def get(self, key_path: str, default: Any = ...) -> Any: ...

    def get(self, key_path: str, default_or_model: Any = None) -> Any:
        """Get configuration value using dot notation (e.g., 'ui.activate').

        Two call signatures (mirrors ``aget``):

        * ``get("services.tts", default={})`` — returns raw dict/scalar.
        * ``get("services.tts", TtsConfig)`` — returns a validated Pydantic model.

        Args:
            key_path: Configuration key path (e.g., 'services.tts')
            default_or_model: Default value or Pydantic model class.

        Returns:
            Configuration value, default, or validated Pydantic model instance.
        """
        import inspect
        import os

        model: type[BaseModel] | None = None
        default: Any = None

        if isinstance(default_or_model, type) and issubclass(default_or_model, BaseModel):
            model = default_or_model
        else:
            default = default_or_model

        try:
            import asyncio

            try:
                asyncio.get_running_loop()
                warning_msg = (
                    f"ConfigAPI.get('{key_path}') called from async context. "
                    "Use 'await config_api.aget()' instead. Returning default value."
                )
                log_warning(warning_msg)
                warnings.warn(warning_msg, RuntimeWarning, stacklevel=3)
                if model is not None:
                    return model()
                return default
            except RuntimeError:
                pass

            keys = key_path.split(".")
            section = keys[0] if keys else None

            stack = inspect.stack()
            if len(stack) > 1:
                caller_frame = stack[1]
                caller_file = (
                    os.path.relpath(caller_frame.filename)
                    if "aurora" in caller_frame.filename
                    else caller_frame.filename
                )
                caller_line = caller_frame.lineno
                caller_func = caller_frame.function
                log_debug(
                    f"ConfigAPI.get('{key_path}') called from {caller_file}:{caller_line} in {caller_func}()"
                )

            if section:
                config = self.get_config(section=section)
                keys_to_iterate = keys[1:]
            else:
                config = self.get_config()
                keys_to_iterate = keys

            value = config

            for k in keys_to_iterate:
                if isinstance(value, dict):
                    value = value.get(k)
                    if value is None:
                        break
                else:
                    value = None
                    break

            if model is not None:
                if value is None or value == {}:
                    return model()
                return model.model_validate(value)

            return value if value is not None else default
        except Exception as e:
            log_error(f"Error getting config value: {e}")
            if model is not None:
                return model()
            return default

    async def aget_app_config(self, *, config_timeout: float = 5.0) -> Any:
        """Get the fully typed application configuration asynchronously.

        .. deprecated:: Use ``aget(ConfigKeys.services.section, SectionModel)`` instead.
        """
        from app.shared.config.models import Model as AppConfig

        config_dict = await self.aget("", default={}, config_timeout=config_timeout)

        try:
            return AppConfig.model_validate(config_dict)
        except Exception as e:
            log_error(f"Failed to validate AppConfig from defaults: {e}")
            return AppConfig()

    @overload
    async def aget(
        self,
        key_path: str,
        model: type[T],
        *,
        config_timeout: float = ...,
        default: T | None = ...,
    ) -> T: ...

    @overload
    async def aget(
        self,
        key_path: str,
        default: Any = ...,
        *,
        config_timeout: float = ...,
    ) -> Any: ...

    async def aget(
        self,
        key_path: str,
        default_or_model: Any = None,
        *,
        config_timeout: float = 5.0,
        default: Any = None,
    ) -> Any:
        """Get configuration value using dot notation (async version).

        Two call signatures:

        * ``await aget("services.tts", default={})`` — returns raw dict/scalar
          (backward-compatible).
        * ``await aget("services.tts", TtsConfig)`` — validates the raw dict
          against the Pydantic model and returns a typed instance.

        Args:
            key_path: Configuration key path (e.g., ``services.tts``).
            default_or_model: Either a default value **or** a Pydantic model
                class.  When a model class is passed, the raw section dict is
                validated against it.
            config_timeout: Timeout for the underlying Config.Get bus request.
            default: Explicit default when using the model overload.

        Returns:
            Configuration value, default, or a validated Pydantic model instance.
        """
        import inspect
        import os

        model: type[BaseModel] | None = None
        actual_default = default

        if isinstance(default_or_model, type) and issubclass(default_or_model, BaseModel):
            model = default_or_model
        elif default is None:
            actual_default = default_or_model

        try:
            keys = key_path.split(".")
            section = keys[0] if keys else None

            stack = inspect.stack()
            if len(stack) > 1:
                caller_frame = stack[1]
                caller_file = (
                    os.path.relpath(caller_frame.filename)
                    if "aurora" in caller_frame.filename
                    else caller_frame.filename
                )
                caller_line = caller_frame.lineno
                caller_func = caller_frame.function
                log_debug(
                    f"ConfigAPI.aget('{key_path}') called from {caller_file}:{caller_line} in {caller_func}()"
                )

            if section:
                config = await self.aget_config(section=section, timeout=config_timeout)
                keys_to_iterate = keys[1:]
            else:
                config = await self.aget_config(timeout=config_timeout)
                keys_to_iterate = keys

            value = config

            for k in keys_to_iterate:
                if isinstance(value, dict):
                    value = value.get(k)
                    if value is None:
                        break
                else:
                    value = None
                    break

            if model is not None:
                if value is None or value == {}:
                    return actual_default if actual_default is not None else model()
                return model.model_validate(value)

            return value if value is not None else actual_default
        except Exception as e:
            log_error(f"Error getting config value: {e}")
            if model is not None:
                return actual_default if actual_default is not None else model()
            return actual_default

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
            section_path: Configuration section path (e.g., 'services.orchestrator.llm.third_party.openai.options')
            default: Default value if section not found

        Returns:
            Configuration section dictionary or default
        """
        return self.get(section_path, default)

    def update_config(self, key_path: str, value: Any) -> bool:
        """Update a specific configuration value.

        Args:
            key_path: Configuration key path (e.g., "services.orchestrator.llm.provider")
            value: New value

        Returns:
            True if successful, False otherwise
        """
        try:
            import asyncio

            command = UpdateConfigCommand(key_path=key_path, value=value)
            result = asyncio.run(self.bus.request(ConfigMethods.SET, command, timeout=5.0))

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

    async def aupdate_config(self, key_path: str, value: Any, *, timeout: float = 15.0) -> bool:
        """Update configuration via ConfigService (async; use from service coroutines).

        Args:
            key_path: Dot-notation path (e.g. ``services.gateway.webrtc.room``).
            value: JSON-serializable value to set.
            timeout: Bus request timeout in seconds.

        Returns:
            True if Config.Set succeeded.
        """
        if not self._ensure_bus():
            log_error("Bus not available for config update")
            return False
        try:
            command = UpdateConfigCommand(key_path=key_path, value=value)
            result = await self.bus.request(ConfigMethods.SET, command, timeout=timeout)
            if result.ok and result.data:
                if hasattr(result.data, "success"):
                    return bool(result.data.success)
                return True
            log_error(f"Error updating config: {getattr(result, 'error', None)}")
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
            result = asyncio.run(self.bus.request(ConfigMethods.SET_PLUGIN, command, timeout=5.0))

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
            result = asyncio.run(self.bus.request(ConfigMethods.GET_PLUGIN, query, timeout=5.0))

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
            result = asyncio.run(self.bus.request(ConfigMethods.VALIDATE, query, timeout=5.0))

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

            self.bus.subscribe(ConfigMethods.UPDATED, on_config_changed)
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
            from app.shared.contracts.models.tooling import ToolingMethods

            result = await self.bus.request(
                ToolingMethods.GET_MCP_STATUS,
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
            from app.shared.contracts.models.tooling import ToolingMethods
            from app.shared.messaging.models.tooling_models import ReloadMCPToolsCommand

            await self.bus.publish(
                ToolingMethods.RELOAD_MCP_TOOLS,
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
            success = self.update_config("services.tooling.mcp.servers", servers_config)
            if not success:
                return {"success": False, "error": "Failed to update config"}

            # Reload servers via bus
            from app.shared.contracts.models.tooling import ToolingMethods
            from app.shared.messaging.models.tooling_models import ReloadMCPToolsCommand

            await self.bus.publish(
                ToolingMethods.RELOAD_MCP_TOOLS,
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

            from app.services.tooling.mcp.mcp_discovery import discover_mcp_servers

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

            return {
                "success": True,
                "servers": servers_info,
                "count": len(servers_info),
                "message": f"Discovered {len(servers_info)} MCP servers",
            }

        except Exception as e:
            log_error(f"Error discovering MCP servers: {e}")
            return {"success": False, "error": str(e)}

    async def add_discovered_servers_to_config(
        self, server_names: list[str] = None
    ) -> dict[str, Any]:
        """Add discovered servers to Aurora's MCP configuration and reload via message bus.

        Args:
            server_names: Optional list of server names to add (None = all discovered)

        Returns:
            Dictionary containing add result
        """
        try:
            from app.services.tooling.mcp.mcp_discovery import mcp_discovery

            discovered = mcp_discovery.get_server_configs_for_aurora()

            # Filter by requested server names if provided
            if server_names:
                discovered = {
                    name: config for name, config in discovered.items() if name in server_names
                }

            # Get current MCP config
            current_servers = self.get("services.tooling.mcp.servers", {})

            # Merge with discovered servers
            updated_servers = current_servers.copy()
            updated_servers.update(discovered)

            # Update configuration
            success = self.update_config("services.tooling.mcp.servers", updated_servers)
            if not success:
                return {"success": False, "error": "Failed to update config"}

            # Reload servers via bus
            from app.shared.contracts.models.tooling import ToolingMethods
            from app.shared.messaging.models.tooling_models import ReloadMCPToolsCommand

            await self.bus.publish(
                ToolingMethods.RELOAD_MCP_TOOLS,
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
