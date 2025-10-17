"""Tooling Service for Aurora's parallel architecture.

This service:
- Manages all tools (core, plugin, MCP)
- Handles tool initialization and lifecycle
- Exposes tool queries via message bus
- Emits events when tools change
"""

from __future__ import annotations

import asyncio
import logging
from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from typing import List, Optional

from pydantic import BaseModel

from app.messaging import Command, Envelope, Event, MessageBus, Query, ToolingTopics
from app.tooling.tools_manager import ToolsManager, get_tools_manager, set_tools_manager

logger = logging.getLogger(__name__)


# Message definitions
class ToolsInitialized(Event):
    """Event emitted when tools are initialized."""

    total_tools: int
    mcp_tools_loaded: bool


class ToolsReloaded(Event):
    """Event emitted when tools are reloaded."""

    total_tools: int


class GetToolsQuery(Query):
    """Query to get available tools."""

    query: Optional[str] = None
    top_k: int = 10


class GetToolByNameQuery(Query):
    """Query to get a specific tool by name."""

    name: str


class ReloadMCPToolsCommand(Command):
    """Command to reload MCP tools."""

    pass


class GetToolStatsQuery(Query):
    """Query to get tooling statistics."""

    pass


# Service implementation
class ToolingService:
    """Tooling service.
    
    Responsibilities:
    - Initialize ToolsManager
    - Load all tools in correct order
    - Handle tool queries via message bus
    - Manage tool lifecycle
    """

    def __init__(self, bus: MessageBus):
        """Initialize tooling service.
        
        Args:
            bus: MessageBus instance
        """
        self.bus = bus
        self.tools_manager = ToolsManager()
        self._started = False

    async def start(self) -> None:
        """Start the tooling service and initialize tools."""
        if self._started:
            log_warning("ToolingService already started")
            return

        log_info("Starting Tooling service...")

        # Set as global instance
        set_tools_manager(self.tools_manager)

        # Subscribe to commands and queries using typed topics
        self.bus.subscribe(ToolingTopics.GET_TOOLS, self._on_get_tools)
        self.bus.subscribe(ToolingTopics.GET_TOOL_BY_NAME, self._on_get_tool_by_name)
        self.bus.subscribe(ToolingTopics.GET_STATS, self._on_get_stats)
        self.bus.subscribe(ToolingTopics.RELOAD_MCP_TOOLS, self._on_reload_mcp)

        # Initialize tools
        log_info("Initializing tools...")
        await self.tools_manager.initialize()

        # Emit initialization event
        stats = self.tools_manager.get_stats()
        await self.bus.publish(
            ToolingTopics.TOOLS_INITIALIZED,
            ToolsInitialized(
                total_tools=stats["total_tools"],
                mcp_tools_loaded=stats["mcp_tools_loaded"]
            ),
            event=True,
            priority=50,
            origin="internal"
        )

        self._started = True
        log_info(f"Tooling service started with {stats['total_tools']} tools")

    async def stop(self) -> None:
        """Stop the tooling service."""
        log_info("Stopping Tooling service...")
        self._started = False
        log_info("Tooling service stopped")

    async def _on_get_tools(self, env: Envelope) -> None:
        """Handle get tools query.
        
        Args:
            env: Message envelope containing GetToolsQuery
        """
        try:
            query = GetToolsQuery.model_validate(env.payload)
            log_debug(f"Getting tools with query: {query.query}")

            tools = self.tools_manager.get_tools(query.query, query.top_k)
            tool_names = [tool.name for tool in tools]

            # Send response
            if env.reply_to:
                response = {
                    "tools": tool_names,
                    "count": len(tool_names)
                }
                await self.bus.publish(env.reply_to, response, origin="internal")

        except Exception as e:
            log_error(f"Error handling get tools query: {e}", exc_info=True)
            if env.reply_to:
                await self.bus.publish(
                    env.reply_to,
                    {"error": str(e)},
                    origin="internal"
                )

    async def _on_get_tool_by_name(self, env: Envelope) -> None:
        """Handle get tool by name query.
        
        Args:
            env: Message envelope containing GetToolByNameQuery
        """
        try:
            query = GetToolByNameQuery.model_validate(env.payload)
            log_debug(f"Getting tool: {query.name}")

            tool = self.tools_manager.get_tool_by_name(query.name)

            # Send response
            if env.reply_to:
                if tool:
                    response = {
                        "found": True,
                        "name": tool.name,
                        "description": getattr(tool, 'description', '')
                    }
                else:
                    response = {
                        "found": False,
                        "name": query.name
                    }
                await self.bus.publish(env.reply_to, response, origin="internal")

        except Exception as e:
            log_error(f"Error handling get tool by name query: {e}", exc_info=True)
            if env.reply_to:
                await self.bus.publish(
                    env.reply_to,
                    {"error": str(e)},
                    origin="internal"
                )

    async def _on_get_stats(self, env: Envelope) -> None:
        """Handle get stats query.
        
        Args:
            env: Message envelope containing GetToolStatsQuery
        """
        try:
            stats = self.tools_manager.get_stats()
            log_debug(f"Tool stats: {stats}")

            # Send response
            if env.reply_to:
                await self.bus.publish(env.reply_to, stats, origin="internal")

        except Exception as e:
            log_error(f"Error handling get stats query: {e}", exc_info=True)
            if env.reply_to:
                await self.bus.publish(
                    env.reply_to,
                    {"error": str(e)},
                    origin="internal"
                )

    async def _on_reload_mcp(self, env: Envelope) -> None:
        """Handle reload MCP tools command.
        
        Args:
            env: Message envelope containing ReloadMCPToolsCommand
        """
        try:
            log_info("Reloading MCP tools...")
            await self.tools_manager.reload_mcp_tools()

            # Emit reloaded event
            stats = self.tools_manager.get_stats()
            await self.bus.publish(
                "Tooling.Reloaded",
                ToolsReloaded(total_tools=stats["total_tools"]),
                event=True,
                priority=50,
                origin="internal"
            )

            log_info("MCP tools reloaded successfully")

        except Exception as e:
            log_error(f"Error reloading MCP tools: {e}", exc_info=True)
