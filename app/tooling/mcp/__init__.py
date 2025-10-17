"""MCP (Model Context Protocol) integration for Aurora tooling.

Contains MCP client and discovery functionality.
"""

from app.tooling.mcp.mcp_client import (
    MCPClientManager,
    get_mcp_tools,
    initialize_mcp,
    mcp_client_manager,
)

__all__ = [
    "MCPClientManager",
    "get_mcp_tools",
    "initialize_mcp",
    "mcp_client_manager",
]
