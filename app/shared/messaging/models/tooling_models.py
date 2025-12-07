"""Tooling service message models."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel

from app.messaging import Command, Event, Query


class ToolsInitialized(Event):
    """Event emitted when tools are initialized."""

    total_tools: int
    mcp_tools_loaded: bool


class ToolsReloaded(Event):
    """Event emitted when tools are reloaded."""

    total_tools: int


class GetToolsQuery(Query):
    """Query to get available tools."""

    query: str | None = None
    top_k: int = 10


class GetToolsResponse(BaseModel):
    """Response for GetToolsQuery."""

    tools: list[dict[str, Any]] = []
    count: int = 0


class GetToolByNameQuery(Query):
    """Query to get a specific tool by name."""

    name: str


class ReloadMCPToolsCommand(Command):
    """Command to reload MCP tools."""

    pass


class GetToolStatsQuery(Query):
    """Query to get tooling statistics."""

    pass


class GetMCPStatusQuery(Query):
    """Query to get MCP integration status."""

    pass


class GetMCPStatusResponse(BaseModel):
    """Response for GetMCPStatusQuery."""

    enabled: bool
    initialized: bool
    tools_loaded: bool
    tool_count: int
    tool_names: list[str]
    servers_configured: list[str]


class ExecuteToolCommand(Command):
    """Command to execute a tool by name."""

    tool_name: str
    arguments: dict[str, Any] = {}


class ExecuteToolResponse(BaseModel):
    """Response for ExecuteToolCommand."""

    ok: bool
    data: Any = None
    error: str | None = None
