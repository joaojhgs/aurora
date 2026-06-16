"""Tooling service contract models."""

from typing import Any

from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.registry import IOModel


# Module identifier
class ToolingModule:
    """Module identifier for Tooling service."""

    NAME = "Tooling"


# Method identifiers
class ToolingMethods:
    """Full method identifiers for Tooling service."""

    GET_TOOLS = f"{ToolingModule.NAME}.GetTools"
    GET_TOOL_BY_NAME = f"{ToolingModule.NAME}.GetToolByName"
    GET_STATS = f"{ToolingModule.NAME}.GetStats"
    GET_MCP_STATUS = f"{ToolingModule.NAME}.GetMCPStatus"
    EXECUTE_TOOL = f"{ToolingModule.NAME}.ExecuteTool"
    RELOAD_MCP_TOOLS = f"{ToolingModule.NAME}.ReloadMCPTools"
    HEALTH_CHECK = f"{ToolingModule.NAME}.HealthCheck"
    TOOLS_INITIALIZED = f"{ToolingModule.NAME}.ToolsInitialized"
    TOOLS_RELOADED = f"{ToolingModule.NAME}.ToolsReloaded"


class ToolingGetToolsRequest(IOModel):
    """Request to get available tools."""

    query: str | None = None
    top_k: int = 100
    mesh_selector: MeshAddressSelector | None = None


class ToolingGetToolsResponse(IOModel):
    """Response with available tools."""

    tools: list[dict[str, Any]]
    count: int


class ToolingGetToolByNameRequest(IOModel):
    """Request to get a specific tool by name."""

    name: str
    mesh_selector: MeshAddressSelector | None = None


class ToolingGetToolByNameResponse(IOModel):
    """Response with tool details."""

    found: bool
    name: str
    description: str | None = None


class ToolingGetStatsRequest(IOModel):
    """Request to get tooling statistics."""

    pass  # No parameters needed


class ToolingGetStatsResponse(IOModel):
    """Response with tooling statistics."""

    total_tools: int
    mcp_tools_loaded: int
    core_tools: int | None = None
    plugin_tools: int | None = None


class ToolingGetMCPStatusRequest(IOModel):
    """Request to get MCP server status."""

    pass  # No parameters needed


class ToolingGetMCPStatusResponse(IOModel):
    """Response with MCP server status."""

    servers: list[dict[str, Any]]
    total_servers: int
    active_servers: int


class ToolingReloadMCPRequest(IOModel):
    """Request to reload MCP tools."""

    pass  # No parameters needed


class ToolingExecuteToolRequest(IOModel):
    """Request to execute a tool."""

    tool_name: str
    arguments: dict[str, Any]
    mesh_selector: MeshAddressSelector | None = None


class ToolingExecuteToolResponse(IOModel):
    """Response from tool execution."""

    ok: bool
    data: Any | None = None
    error: str | None = None


class ToolingToolsInitializedEvent(IOModel):
    """Event emitted when tools are initialized."""

    total_tools: int
    mcp_tools_loaded: int


class ToolingToolsReloadedEvent(IOModel):
    """Event emitted when tools are reloaded."""

    total_tools: int
