from typing import Any

from app.config.config_manager import config_manager
from app.helpers.aurora_logger import log_error


class ConfigAPI:
    """API for runtime configuration changes"""

    @staticmethod
    def get_config(section: str = None) -> dict[str, Any]:
        """Get entire config or specific section"""
        if section:
            return config_manager.get(section, {})
        return config_manager.get_config_dict()

    @staticmethod
    def update_config(key_path: str, value: Any) -> bool:
        """Update a specific configuration value"""
        try:
            config_manager.set(key_path, value)
            return True
        except Exception as e:
            log_error(f"Error updating config: {e}")
            return False

    @staticmethod
    def update_plugin_status(plugin_name: str, active: bool) -> bool:
        """Enable/disable a plugin"""
        return ConfigAPI.update_config(f"plugins.{plugin_name}.activate", active)

    @staticmethod
    def get_plugin_status(plugin_name: str) -> bool:
        """Check if a plugin is active"""
        return config_manager.get(f"plugins.{plugin_name}.activate", False)

    @staticmethod
    def validate_config() -> list[str]:
        """Validate current configuration"""
        return config_manager.validate_config()

    @staticmethod
    def add_config_observer(callback):
        """Add observer for configuration changes"""
        config_manager.add_observer(callback)

    @staticmethod
    def remove_config_observer(callback):
        """Remove observer for configuration changes"""
        config_manager.remove_observer(callback)

    @staticmethod
    def get_mcp_status() -> dict[str, Any]:
        """Get MCP system status"""
        try:
            from app.langgraph.tools.tools import get_mcp_status

            return get_mcp_status()
        except Exception as e:
            log_error(f"Error getting MCP status: {e}")
            return {"error": str(e)}

    @staticmethod
    def reload_mcp_servers() -> dict[str, Any]:
        """Reload MCP servers from configuration"""
        try:
            from app.langgraph.tools.tools import reload_mcp_servers_sync

            reload_mcp_servers_sync()
            return {"success": True, "message": "MCP servers reload initiated"}
        except Exception as e:
            log_error(f"Error reloading MCP servers: {e}")
            return {"success": False, "error": str(e)}

    @staticmethod
    def update_mcp_config(servers_config: dict[str, Any]) -> dict[str, Any]:
        """Update MCP servers configuration and reload"""
        try:
            # Update configuration
            config_manager.set("mcp.servers", servers_config)

            # Reload servers
            from app.langgraph.tools.tools import reload_mcp_servers_sync

            reload_mcp_servers_sync()

            return {"success": True, "message": "MCP configuration updated and servers reloaded"}
        except Exception as e:
            log_error(f"Error updating MCP config: {e}")
            return {"success": False, "error": str(e)}

    @staticmethod
    def discover_mcp_servers() -> dict[str, Any]:
        """Discover MCP servers using various methods"""
        try:
            import asyncio

            from app.langgraph.mcp_discovery import discover_mcp_servers

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

    @staticmethod
    def add_discovered_servers_to_config(server_names: list[str] = None) -> dict[str, Any]:
        """Add discovered servers to Aurora's MCP configuration"""
        try:
            from app.langgraph.mcp_discovery import mcp_discovery

            discovered = mcp_discovery.get_server_configs_for_aurora()

            # Filter by requested server names if provided
            if server_names:
                discovered = {name: config for name, config in discovered.items() if name in server_names}

            # Get current MCP config
            current_servers = config_manager.get("mcp.servers", {})

            # Merge with discovered servers
            updated_servers = current_servers.copy()
            updated_servers.update(discovered)

            # Update configuration
            config_manager.set("mcp.servers", updated_servers)

            # Reload servers
            from app.langgraph.tools.tools import reload_mcp_servers_sync

            reload_mcp_servers_sync()

            return {
                "success": True,
                "added_servers": list(discovered.keys()),
                "total_servers": len(updated_servers),
                "message": f"Added {len(discovered)} discovered servers to configuration",
            }

        except Exception as e:
            log_error(f"Error adding discovered servers: {e}")
            return {"success": False, "error": str(e)}


# Global API instance
config_api = ConfigAPI()
