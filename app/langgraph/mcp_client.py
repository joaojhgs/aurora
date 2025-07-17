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
                try:
                    log_debug(f"Preparing config for server '{name}' with transport '{server_config.get('transport')}'")
                    client_config[name] = self._prepare_server_config(server_config)
                    log_debug(f"Prepared config for server '{name}': {client_config[name]}")
                except Exception as e:
                    log_error(f"Invalid configuration for server '{name}': {e}")
                    import traceback

                    log_debug(f"Server config preparation traceback:\n{traceback.format_exc()}")
                    continue

            if not client_config:
                log_warning("No valid MCP server configurations found")
                return

            # Create MCP client with timeout handling
            import asyncio

            try:
                log_debug("Creating MultiServerMCPClient...")
                async with asyncio.timeout(30):  # 30 second timeout for initialization
                    self._client = MultiServerMCPClient(client_config)
                    log_debug("MultiServerMCPClient created successfully")

                    # Load tools from all servers
                    log_debug("Loading tools from MCP servers...")
                    await self._load_tools()
                    log_debug("Tool loading completed")
            except asyncio.TimeoutError:
                log_error("MCP client initialization timed out after 30 seconds")
                if self._client:
                    try:
                        # Check if client has close method before calling
                        if hasattr(self._client, "close"):
                            await self._client.close()
                        elif hasattr(self._client, "shutdown"):
                            await self._client.shutdown()
                    except Exception as close_e:
                        log_debug(f"Error during client cleanup: {close_e}")
                    finally:
                        self._client = None
                return
            except Exception as e:
                log_error(f"Failed to create MCP client or load tools: {e}")
                # Log full traceback for debugging
                import traceback

                log_debug(f"MCP client creation full traceback:\n{traceback.format_exc()}")
                if self._client:
                    try:
                        if hasattr(self._client, "close"):
                            await self._client.close()
                        elif hasattr(self._client, "shutdown"):
                            await self._client.shutdown()
                    except Exception as close_e:
                        log_debug(f"Error during client cleanup: {close_e}")
                    finally:
                        self._client = None
                return

            self._initialized = True
            log_info(f"MCP client initialized successfully with {len(self._tools)} tools")

        except ImportError as e:
            log_error(f"MCP dependencies not available: {e}")
            log_warning("Install with: pip install langchain-mcp-adapters")
        except Exception as e:
            log_error(f"Failed to initialize MCP client: {e}")
            import traceback

            log_debug(f"MCP initialization traceback: {traceback.format_exc()}")

    def _prepare_server_config(self, server_config: dict[str, Any]) -> dict[str, Any]:
        """Prepare server configuration for MultiServerMCPClient."""
        transport = server_config.get("transport")
        if not transport:
            raise ValueError("Transport type is required")

        config = {"transport": transport}

        if transport == "stdio":
            command = server_config.get("command")
            if not command:
                raise ValueError("Command is required for stdio transport")
            config["command"] = command

            # Validate and add args if present
            if "args" in server_config:
                args = server_config["args"]
                if isinstance(args, str):
                    # If args is a string, try to parse as JSON, otherwise treat as single arg
                    try:
                        import json

                        args = json.loads(args)
                    except json.JSONDecodeError:
                        args = [args]
                elif not isinstance(args, list):
                    raise ValueError("Args must be a list or valid JSON string")
                config["args"] = args

            # Add optional stdio fields
            for field in ["cwd", "env", "timeout"]:
                if field in server_config:
                    config[field] = server_config[field]

        elif transport in ["streamable_http", "sse", "websocket"]:
            url = server_config.get("url")
            if not url:
                raise ValueError(f"URL is required for {transport} transport")
            config["url"] = url

            # Add optional HTTP fields
            if "headers" in server_config and server_config["headers"]:
                config["headers"] = server_config["headers"]

            if "timeout" in server_config:
                config["timeout"] = server_config["timeout"]

            # Check if this is an Atlassian MCP server that needs authentication
            if "atlassian.com" in url and transport == "sse":
                log_warning(f"Server '{url}' appears to be an Atlassian MCP server using SSE transport.")
                log_warning("SSE transport requires authentication. Consider using 'stdio' transport with 'mcp-remote' for automatic OAuth handling.")
                log_warning("Example: transport='stdio', command='npm', args=['exec', 'mcp-remote', '{url}']")
        else:
            raise ValueError(f"Unsupported transport type: {transport}")

        return config

    async def _load_tools(self) -> None:
        """Load tools from all configured MCP servers."""
        if not self._client:
            return

        try:
            log_debug("Attempting to get tools from MCP client...")
            # Get tools from all servers
            tools = await self._client.get_tools()
            self._tools = tools or []

            log_debug(f"Loaded {len(self._tools)} tools from MCP servers")
            for tool in self._tools:
                log_debug(f"  - {tool.name}: {tool.description}")

        except Exception as e:
            log_error(f"Failed to load MCP tools: {e}")

            # Provide user-friendly error messages for common issues
            error_str = str(e)
            if "401 Unauthorized" in error_str:
                log_error("MCP server authentication failed (401 Unauthorized)")
                if "atlassian.com" in error_str:
                    log_error("This Atlassian MCP server requires authentication.")
                    log_error("Recommended solution: Use 'stdio' transport with 'mcp-remote' instead of direct SSE.")
                    log_error("Example config: transport='stdio', command='npm', args=['exec', 'mcp-remote', 'https://mcp.atlassian.com/v1/sse']")
                else:
                    log_error("The MCP server requires authentication headers. Add them to the 'headers' section in config.")
            elif "Connection refused" in error_str or "Failed to connect" in error_str:
                log_error("Failed to connect to MCP server. Check if the server is running and accessible.")
            elif "TimeoutError" in error_str or "timeout" in error_str.lower():
                log_error("Connection to MCP server timed out. The server may be slow or unreachable.")

            # Log the full traceback for better debugging
            import traceback

            log_debug(f"MCP tools loading full traceback:\n{traceback.format_exc()}")
            self._tools = []

    def get_tools(self) -> list[BaseTool]:
        """Get list of tools loaded from MCP servers."""
        return self._tools.copy()

    async def close(self) -> None:
        """Close MCP client connections."""
        if self._client:
            try:
                # Check what close methods are available
                if hasattr(self._client, "close"):
                    await self._client.close()
                elif hasattr(self._client, "shutdown"):
                    await self._client.shutdown()
                else:
                    log_debug("MCP client has no close/shutdown method")
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
