"""
MCP (Model Context Protocol) client integration for Aurora.

This module provides MCP client functionality using the langchain-mcp-adapters
to connect to both local (stdio) and remote (HTTP) MCP servers and load their
tools into Aurora's tool system.
"""

from typing import Any, Optional

from langchain_core.tools import BaseTool

from app.config.config_manager import config_manager
from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning


class MCPClientManager:
    """Manages MCP server connections and tool loading."""

    def __init__(self):
        self._client: Optional[Any] = None
        self._tools: list[BaseTool] = []
        self._initialized = False

    async def initialize(self) -> None:
        """Initialize MCP client and load tools from configured servers."""
        if not config_manager.get("mcp.enabled", True):
            log_info("MCP integration disabled in configuration")
            return

        servers_config = config_manager.get("mcp.servers", {})
        if not servers_config:
            log_info("No MCP servers configured")
            return

        try:
            # Filter enabled servers
            enabled_servers = {name: config for name, config in servers_config.items() if config.get("enabled", True)}

            if not enabled_servers:
                log_info("No enabled MCP servers found")
                return

            log_info(f"Initializing MCP client with {len(enabled_servers)} server(s)")

            # Import MCP dependencies
            from langchain_mcp_adapters.client import MultiServerMCPClient

            # Prepare server configurations for MultiServerMCPClient
            client_config = {}
            for name, server_config in enabled_servers.items():
                client_config[name] = self._prepare_server_config(server_config)

            # Create MCP client
            self._client = MultiServerMCPClient(client_config)

            # Load tools from all servers
            await self._load_tools()

            self._initialized = True
            log_info(f"MCP client initialized successfully with {len(self._tools)} tools")

        except ImportError as e:
            log_error(f"MCP dependencies not available: {e}")
            log_warning("Install with: pip install langchain-mcp-adapters")
        except Exception as e:
            log_error(f"Failed to initialize MCP client: {e}")

    def _prepare_server_config(self, server_config: dict[str, Any]) -> dict[str, Any]:
        """Prepare server configuration for MultiServerMCPClient."""
        transport = server_config.get("transport")
        config = {"transport": transport}

        if transport == "stdio":
            config["command"] = server_config.get("command")
            if "args" in server_config:
                config["args"] = server_config["args"]

        elif transport in ["streamable_http", "sse"]:
            config["url"] = server_config.get("url")
            if "headers" in server_config:
                config["headers"] = server_config["headers"]

        return config

    async def _load_tools(self) -> None:
        """Load tools from all configured MCP servers."""
        if not self._client:
            return

        try:
            # Get tools from all servers
            tools = await self._client.get_tools()
            self._tools = tools or []

            log_debug(f"Loaded {len(self._tools)} tools from MCP servers")
            for tool in self._tools:
                log_debug(f"  - {tool.name}: {tool.description}")

        except Exception as e:
            log_error(f"Failed to load MCP tools: {e}")
            self._tools = []

    def get_tools(self) -> list[BaseTool]:
        """Get list of tools loaded from MCP servers."""
        return self._tools.copy()

    async def close(self) -> None:
        """Close MCP client connections."""
        if self._client:
            try:
                # Close client connections if it has a close method
                if hasattr(self._client, "close"):
                    await self._client.close()
                log_debug("MCP client connections closed")
            except Exception as e:
                log_error(f"Error closing MCP client: {e}")
            finally:
                self._client = None
                self._tools = []
                self._initialized = False

    @property
    def is_initialized(self) -> bool:
        """Check if MCP client is initialized."""
        return self._initialized

    async def reload_tools(self) -> None:
        """Reload tools from MCP servers."""
        log_info("Reloading MCP tools...")
        await self.close()
        await self.initialize()


# Global MCP client manager instance
mcp_client_manager = MCPClientManager()


async def get_mcp_tools() -> list[BaseTool]:
    """
    Get MCP tools, initializing the client if necessary.

    Returns:
        List of MCP tools available from configured servers
    """
    if not mcp_client_manager.is_initialized:
        await mcp_client_manager.initialize()

    return mcp_client_manager.get_tools()


async def initialize_mcp() -> None:
    """Initialize MCP client. Call this at startup."""
    await mcp_client_manager.initialize()


async def cleanup_mcp() -> None:
    """Clean up MCP resources. Call this at shutdown."""
    await mcp_client_manager.close()
