"""Tools Manager for Aurora.

Manages the lifecycle of all tools including loading, registration, and database sync.
Ensures proper initialization order: load MCP tools first, then sync with database.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Callable

from app.config.config_manager import config_manager
from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning

logger = logging.getLogger(__name__)


class ToolsManager:
    """Manages all tools for Aurora.

    Responsibilities:
    - Load core Aurora tools
    - Load plugin tools based on configuration
    - Load MCP tools
    - Sync tools with database
    - Provide tool discovery and retrieval
    """

    def __init__(self):
        """Initialize the ToolsManager."""
        self.tools: list[Callable] = []
        self.tool_lookup: dict[str, Callable] = {}
        self.always_active_tools: list[Callable] = []
        self._mcp_tools_loaded = False
        self._initialized = False

    async def initialize(self) -> None:
        """Initialize all tools in the correct order.

        Order:
        1. Load core Aurora tools
        2. Load plugin tools
        3. Load MCP tools
        4. Sync with database (only after everything is loaded)
        """
        if self._initialized:
            log_warning("ToolsManager already initialized")
            return

        log_info("Initializing ToolsManager...")

        # Step 1: Load core tools
        await self._load_core_tools()

        # Step 2: Load plugin tools
        await self._load_plugin_tools()

        # Step 3: Load MCP tools
        await self._load_mcp_tools()

        # Step 4: Sync with database (AFTER all tools are loaded)
        await self._sync_tools_with_database()

        self._initialized = True
        log_info(f"ToolsManager initialized with {len(self.tools)} tools")

    async def _load_core_tools(self) -> None:
        """Load core Aurora tools."""
        log_info("Loading core Aurora tools...")

        try:
            # Import core tools
            from app.tooling.tools.pomodoro_tool import (
                pomodoro_status_tool,
                start_pomodoro_tool,
                stop_pomodoro_tool,
            )
            from app.tooling.tools.resume_tts import resume_tts_tool
            from app.tooling.tools.scheduler_tool import (
                cancel_scheduled_task_tool,
                list_scheduled_tasks_tool,
                schedule_task_tool,
            )
            from app.tooling.tools.stop_tts import stop_tts_tool
            from app.tooling.tools.upsert_memory import upsert_memory_tool

            # Always active tools
            self.always_active_tools = [upsert_memory_tool]

            # Core tools
            core_tools = [
                resume_tts_tool,
                stop_tts_tool,
                schedule_task_tool,
                list_scheduled_tasks_tool,
                cancel_scheduled_task_tool,
                start_pomodoro_tool,
                stop_pomodoro_tool,
                pomodoro_status_tool,
            ]

            self.tools.extend(core_tools)
            log_info(f"Loaded {len(core_tools)} core tools")

        except Exception as e:
            log_error(f"Error loading core tools: {e}", exc_info=True)
            raise

    async def _load_plugin_tools(self) -> None:
        """Load plugin tools based on configuration."""
        log_info("Loading plugin tools...")

        # OpenRecall plugin
        if config_manager.get("plugins.openrecall.activate", False):
            try:
                from app.tooling.tools.current_screen import current_screen_tool

                self.tools.append(current_screen_tool)
                log_info("Loaded OpenRecall plugin tools")
            except Exception as e:
                log_warning(f"Failed to load OpenRecall tools: {e}")

        # Jira plugin
        if config_manager.get("plugins.jira.activate", False):
            try:
                from app.tooling.tools.jira_toolkit import jira_tools

                self.tools.extend(jira_tools)
                log_info(f"Loaded {len(jira_tools)} Jira plugin tools")
            except Exception as e:
                log_warning(f"Failed to load Jira tools: {e}")

        # Slack plugin
        if config_manager.get("plugins.slack.activate", False):
            try:
                from app.tooling.tools.slack_toolkit import slack_tools

                self.tools.extend(slack_tools)
                log_info(f"Loaded {len(slack_tools)} Slack plugin tools")
            except Exception as e:
                log_warning(f"Failed to load Slack tools: {e}")

        # GitHub plugin
        if config_manager.get("plugins.github.activate", False):
            try:
                from app.tooling.tools.github_toolkit import github_tools

                self.tools.extend(github_tools)
                log_info(f"Loaded {len(github_tools)} GitHub plugin tools")
            except Exception as e:
                log_warning(f"Failed to load GitHub tools: {e}")

    async def _load_mcp_tools(self) -> None:
        """Load MCP (Model Context Protocol) tools."""
        if not config_manager.get("mcp.enabled", True):
            log_info("MCP is disabled in configuration")
            return

        log_info("Loading MCP tools...")

        try:
            from app.tooling.mcp.mcp_client import get_mcp_tools, initialize_mcp

            # Initialize MCP client with timeout
            log_debug("Initializing MCP client...")
            try:
                async with asyncio.timeout(60):
                    await initialize_mcp()
                log_debug("MCP initialization completed")
            except asyncio.TimeoutError:
                log_error("MCP initialization timed out")
                return
            except Exception as e:
                log_error(f"MCP initialization failed: {e}")
                return

            # Get MCP tools
            log_debug("Retrieving MCP tools...")
            mcp_tools = await get_mcp_tools()

            if mcp_tools:
                # Add MCP tools that aren't already loaded
                for tool in mcp_tools:
                    if tool.name not in self.tool_lookup:
                        self.tools.append(tool)

                self._mcp_tools_loaded = True
                log_info(f"Loaded {len(mcp_tools)} MCP tools")
            else:
                log_info("No MCP tools loaded")

        except Exception as e:
            log_error(f"Failed to load MCP tools: {e}", exc_info=True)

    async def _sync_tools_with_database(self) -> None:
        """Sync tools with database.

        This is called AFTER all tools are loaded to ensure no tools are
        incorrectly removed from the database.
        """
        log_info("Synchronizing tools with database...")

        try:
            # Build tool lookup
            self.tool_lookup.clear()
            for tool in self.tools:
                self.tool_lookup[tool.name] = tool

            # Import and call the sync function
            from app.tooling.tools.tools import sync_tools_with_database

            sync_tools_with_database()

            log_info("Tools synchronized with database")

        except Exception as e:
            log_error(f"Failed to sync tools with database: {e}", exc_info=True)

    def get_tools(self, query: str | None = None, top_k: int = 10) -> list[Callable]:
        """Get tools, optionally filtered by query.

        Args:
            query: Optional search query
            top_k: Number of tools to return

        Returns:
            List of tool callables
        """
        if not self._initialized:
            log_warning("ToolsManager not initialized, returning empty list")
            return []

        if query is None:
            return self.tools

        # Use the original get_tools function for semantic search
        try:
            from app.tooling.tools.tools import get_tools

            return get_tools(query, top_k)
        except Exception as e:
            log_error(f"Error in get_tools: {e}")
            return self.tools[:top_k]

    def get_tool_by_name(self, name: str) -> Callable | None:
        """Get a specific tool by name.

        Args:
            name: Tool name

        Returns:
            Tool callable or None
        """
        return self.tool_lookup.get(name)

    def get_all_tool_names(self) -> list[str]:
        """Get names of all loaded tools.

        Returns:
            List of tool names
        """
        return list(self.tool_lookup.keys())

    def get_stats(self) -> dict:
        """Get tooling statistics.

        Returns:
            Dictionary with tool statistics
        """
        return {
            "total_tools": len(self.tools),
            "mcp_tools_loaded": self._mcp_tools_loaded,
            "initialized": self._initialized,
            "core_tools": len([t for t in self.tools if not hasattr(t, "_is_mcp_tool")]),
        }

    async def reload_mcp_tools(self) -> None:
        """Reload MCP tools (useful for configuration changes)."""
        log_info("Reloading MCP tools...")

        # Remove existing MCP tools
        if self._mcp_tools_loaded:
            from app.tooling.mcp.mcp_client import mcp_client_manager

            if mcp_client_manager.is_initialized:
                current_mcp_tools = mcp_client_manager.get_tools()
                mcp_tool_names = [tool.name for tool in current_mcp_tools]

                # Remove from tools list and lookup
                self.tools = [t for t in self.tools if t.name not in mcp_tool_names]
                for name in mcp_tool_names:
                    self.tool_lookup.pop(name, None)

                # Close MCP client
                await mcp_client_manager.close()

        # Reset flag
        self._mcp_tools_loaded = False

        # Reload MCP tools
        await self._load_mcp_tools()

        # Re-sync with database
        await self._sync_tools_with_database()

        log_info("MCP tools reloaded")


# Global instance
_tools_manager: ToolsManager | None = None


def get_tools_manager() -> ToolsManager:
    """Get the global ToolsManager instance.

    Returns:
        ToolsManager instance

    Raises:
        RuntimeError: If ToolsManager not initialized
    """
    if _tools_manager is None:
        raise RuntimeError("ToolsManager not initialized")
    return _tools_manager


def set_tools_manager(manager: ToolsManager) -> None:
    """Set the global ToolsManager instance.

    Args:
        manager: ToolsManager instance
    """
    global _tools_manager
    _tools_manager = manager
