"""Tools Manager for Aurora.

Manages the lifecycle of all tools including loading, registration, and database sync.
Ensures proper initialization order: load MCP tools first, then sync with database.
"""

from __future__ import annotations

import asyncio
from typing import Callable

from app.shared.config.interface import ConfigAPI

config_api = ConfigAPI()
from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.messaging import MessageBus


class ToolsManager:
    """Manages all tools for Aurora.

    Responsibilities:
    - Load core Aurora tools
    - Load plugin tools based on configuration
    - Load MCP tools
    - Sync tools with database
    - Provide tool discovery and retrieval
    """

    def __init__(self, bus: MessageBus):
        """Initialize the ToolsManager."""
        self.bus = bus
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
            from app.services.tooling.tools.pomodoro_tool import (
                pomodoro_status_tool,
                start_pomodoro_tool,
                stop_pomodoro_tool,
            )
            from app.services.tooling.tools.resume_tts import resume_tts_tool
            from app.services.tooling.tools.scheduler_tool import (
                cancel_scheduled_task_tool,
                list_scheduled_tasks_tool,
                schedule_task_tool,
            )
            from app.services.tooling.tools.stop_tts import stop_tts_tool
            from app.services.tooling.tools.upsert_memory import upsert_memory_tool

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
        if config_api.get("plugins.openrecall.activate", False):
            try:
                from app.services.tooling.tools.current_screen import current_screen_tool

                self.tools.append(current_screen_tool)
                log_info("Loaded OpenRecall plugin tools")
            except Exception as e:
                log_warning(f"Failed to load OpenRecall tools: {e}")

        # Jira plugin
        if config_api.get("plugins.jira.activate", False):
            try:
                from app.services.tooling.tools.jira_toolkit import jira_tools

                self.tools.extend(jira_tools)
                log_info(f"Loaded {len(jira_tools)} Jira plugin tools")
            except Exception as e:
                log_warning(f"Failed to load Jira tools: {e}")

        # Slack plugin
        if config_api.get("plugins.slack.activate", False):
            try:
                from app.services.tooling.tools.slack_toolkit import slack_tools

                self.tools.extend(slack_tools)
                log_info(f"Loaded {len(slack_tools)} Slack plugin tools")
            except Exception as e:
                log_warning(f"Failed to load Slack tools: {e}")

        # GitHub plugin
        if config_api.get("plugins.github.activate", False):
            try:
                from app.services.tooling.tools.github_toolkit import github_tools

                self.tools.extend(github_tools)
                log_info(f"Loaded {len(github_tools)} GitHub plugin tools")
            except Exception as e:
                log_warning(f"Failed to load GitHub tools: {e}")

        # Search tools (Brave or DuckDuckGo as fallback)
        if config_api.get("plugins.brave_search.activate", False):
            try:
                from app.services.tooling.tools.brave_search import search_brave_tool

                self.tools.append(search_brave_tool)
                log_info("Loaded Brave Search tool")
            except Exception as e:
                log_warning(f"Failed to load Brave Search tool: {e}")
        else:
            # DuckDuckGo as fallback when Brave is not activated
            try:
                from app.services.tooling.tools.duckduckgo_search import duckduckgo_search_tool

                self.tools.append(duckduckgo_search_tool)
                log_info("Loaded DuckDuckGo Search tool")
            except Exception as e:
                log_warning(f"Failed to load DuckDuckGo Search tool: {e}")

        # Gmail plugin
        if config_api.get("plugins.gmail.activate", False):
            try:
                from app.services.tooling.tools.gmail_toolkit import gmail_tools

                self.tools.extend(gmail_tools)
                log_info(f"Loaded {len(gmail_tools)} Gmail plugin tools")
            except Exception as e:
                log_warning(f"Failed to load Gmail tools: {e}")

        # GCalendar plugin
        if config_api.get("plugins.gcalendar.activate", False):
            try:
                from app.services.tooling.tools.gcalendar_toolkit import gcalendar_tools

                self.tools.extend(gcalendar_tools)
                log_info(f"Loaded {len(gcalendar_tools)} GCalendar plugin tools")
            except Exception as e:
                log_warning(f"Failed to load GCalendar tools: {e}")

    async def _load_mcp_tools(self) -> None:
        """Load MCP (Model Context Protocol) tools."""
        if not config_api.get("mcp.enabled", True):
            log_info("MCP is disabled in configuration")
            return

        log_info("Loading MCP tools...")

        try:
            from app.services.tooling.mcp.mcp_client import get_mcp_tools, initialize_mcp

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
        incorrectly removed from the database. Includes both core/plugin tools and MCP tools.
        """
        log_info("Synchronizing tools with database...")

        if not self.bus:
            log_error("Bus not available for tool synchronization")
            return

        try:
            # Build tool lookup
            self.tool_lookup.clear()
            for tool in self.tools:
                self.tool_lookup[tool.name] = tool
                log_debug(f"Registered tool: {tool.name}")

            # Get currently active tools (both core/plugin and MCP tools)
            active_tools = {}
            for tool in self.tools:
                active_tools[tool.name] = {"name": tool.name, "description": tool.description}

            log_debug(f"DEBUG: Found {len(active_tools)} active tools:")
            for name in active_tools.keys():
                log_debug(f"  - '{name}'")

            # Get existing tools from database via bus
            from app.shared.messaging.models.db_models import RAGDeleteCommand, RAGListQuery, RAGStoreCommand
            from app.messaging import DBTopics

            result = await self.bus.request(
                DBTopics.RAG_LIST,
                RAGListQuery(namespace=("tools",), limit=4000),
                timeout=5.0,
            )

            if result.ok and result.data and "items" in result.data:
                existing_items_data = result.data["items"]
                existing_tools = {item["key"]: item["value"] for item in existing_items_data}
                log_debug(f"DEBUG: Found {len(existing_tools)} existing tools in database:")
                for name in existing_tools.keys():
                    log_debug(f"  - '{name}'")
            else:
                existing_tools = {}
                if not result.ok:
                    log_error(f"Error getting existing tools from database: {result.error}")

            # Find tools to add (active but not in database)
            tools_to_add = []
            for name, tool_data in active_tools.items():
                if name not in existing_tools:
                    tools_to_add.append((name, tool_data))
                elif existing_tools[name].get("description") != tool_data["description"]:
                    # Tool exists but description changed - update it
                    log_info(f"Updating tool '{name}' with new description")
                    await self.bus.publish(
                        DBTopics.RAG_STORE,
                        RAGStoreCommand(namespace=("tools",), key=name, value=tool_data, index=["name", "description"]),
                        event=False,
                    )

            # Find tools to remove (in database but not active)
            tools_to_remove = []
            for name in existing_tools.keys():
                if name not in active_tools:
                    tools_to_remove.append(name)
                    log_debug(f"DEBUG: Will remove '{name}' (not in active tools)")

            # Add new tools via bus
            for name, tool_data in tools_to_add:
                log_info(f"Adding new tool to database: {name}")
                await self.bus.publish(
                    DBTopics.RAG_STORE,
                    RAGStoreCommand(namespace=("tools",), key=name, value=tool_data, index=["name", "description"]),
                    event=False,
                )

            # Remove inactive tools via bus
            for name in tools_to_remove:
                log_info(f"Removing inactive tool from database: {name}")
                await self.bus.publish(
                    DBTopics.RAG_DELETE,
                    RAGDeleteCommand(namespace=("tools",), key=name),
                    event=False,
                )

            log_info(f"Tool synchronization complete. Added: {len(tools_to_add)}, Removed: {len(tools_to_remove)}")

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
        # Note: This is now async, but ToolsManager.get_tools is sync
        # We need to handle this differently - for now, return tools without search
        # The actual RAG search happens in ToolingService._on_get_tools
        log_warning("get_tools called with query but ToolsManager.get_tools is sync - falling back to all tools")
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
            from app.services.tooling.mcp.mcp_client import mcp_client_manager

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

    def get_mcp_status(self) -> dict:
        """Get the current status of MCP integration.

        Returns:
            Dictionary with MCP status information
        """
        try:
            from app.services.tooling.mcp.mcp_client import mcp_client_manager

            # Count MCP tools
            mcp_tool_count = 0
            mcp_tool_names = []
            if mcp_client_manager.is_initialized:
                current_mcp_tools = mcp_client_manager.get_tools()
                mcp_tool_count = len(current_mcp_tools)
                mcp_tool_names = [tool.name for tool in current_mcp_tools]

            return {
                "enabled": config_api.get("mcp.enabled", True),
                "initialized": mcp_client_manager.is_initialized,
                "tools_loaded": self._mcp_tools_loaded,
                "tool_count": mcp_tool_count,
                "tool_names": mcp_tool_names,
                "servers_configured": list(config_api.get("mcp.servers", {}).keys()),
            }
        except Exception as e:
            log_error(f"Failed to get MCP status: {e}")
            return {
                "enabled": config_api.get("mcp.enabled", True),
                "initialized": False,
                "tools_loaded": False,
                "tool_count": 0,
                "tool_names": [],
                "servers_configured": [],
            }


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


async def sync_tools_with_database(bus: MessageBus) -> None:
    """Standalone function for syncing tools with database.

    This is a convenience function that uses the global ToolsManager instance.
    For backward compatibility with existing code.

    Note: The bus parameter is kept for backward compatibility but the manager's
    internal bus is used. Ensure the manager was initialized with the correct bus.

    Args:
        bus: MessageBus instance for database operations (kept for compatibility)
    """
    manager = get_tools_manager()
    # Ensure the manager's bus matches the provided bus (for safety)
    if manager.bus is not bus:
        log_warning("Bus parameter provided differs from manager's bus. Using manager's bus.")
    await manager._sync_tools_with_database()


def get_mcp_status() -> dict:
    """Standalone function for getting MCP status.

    This is a convenience function that uses the global ToolsManager instance.
    For backward compatibility with existing code.

    Returns:
        Dictionary with MCP status information
    """
    try:
        manager = get_tools_manager()
        return manager.get_mcp_status()
    except RuntimeError:
        # ToolsManager not initialized, return minimal status
        return {
            "enabled": config_api.get("mcp.enabled", True),
            "initialized": False,
            "tools_loaded": False,
            "tool_count": 0,
            "tool_names": [],
            "servers_configured": list(config_api.get("mcp.servers", {}).keys()),
        }


def reload_mcp_servers_sync() -> None:
    """Synchronously reload MCP servers and tools.

    This is a convenience function that wraps the async reload_mcp_tools method.
    For backward compatibility with existing code that expects a sync function.

    Note: This function uses asyncio.run() and should not be called from within
    an async context. For async contexts, use ToolsManager.reload_mcp_tools() directly.
    """
    try:
        import asyncio

        manager = get_tools_manager()
        asyncio.run(manager.reload_mcp_tools())
    except RuntimeError:
        log_error("ToolsManager not initialized, cannot reload MCP servers")
    except Exception as e:
        log_error(f"Failed to reload MCP servers: {e}", exc_info=True)
