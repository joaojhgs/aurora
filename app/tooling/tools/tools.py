from typing import Callable

from app.config.config_manager import config_manager
from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.orchestrator.memory_store import store  # Memory store is now in orchestrator module

# Pomodoro tools
from app.tooling.tools.pomodoro_tool import (
    pomodoro_status_tool,
    start_pomodoro_tool,
    stop_pomodoro_tool,
)
from app.tooling.tools.resume_tts import resume_tts_tool

# Scheduler tools
from app.tooling.tools.scheduler_tool import (
    cancel_scheduled_task_tool,
    list_scheduled_tasks_tool,
    schedule_task_tool,
)
from app.tooling.tools.stop_tts import stop_tts_tool
from app.tooling.tools.upsert_memory import upsert_memory_tool

# NOTE: Tool initialization is now handled by ToolingService
# This module provides the tool definitions, but actual loading and
# registration is done by the ToolingService to ensure proper order

# Make memory upsert is always active so that the chatbot can always store
# something new it deems worthwhile
always_active_tools = [upsert_memory_tool]

# Export all tools to bind to LLM - scheduler and pomodoro tools are always available
tools = [
    resume_tts_tool,
    stop_tts_tool,
    schedule_task_tool,
    list_scheduled_tasks_tool,
    cancel_scheduled_task_tool,
    start_pomodoro_tool,
    stop_pomodoro_tool,
    pomodoro_status_tool,
]

# Only import if plugin is activated

if config_manager.get("plugins.openrecall.activate", False):
    from app.tooling.tools.current_screen import current_screen_tool

    tools.append(current_screen_tool)

if config_manager.get("plugins.jira.activate", False):
    from app.tooling.tools.jira_toolkit import jira_tools

    tools.extend(jira_tools)

if config_manager.get("plugins.openrecall.activate", False):
    from app.tooling.tools.openrecall_search import openrecall_search_tool

    tools.append(openrecall_search_tool)

if config_manager.get("plugins.brave_search.activate", False):
    from app.tooling.tools.brave_search import search_brave_tool

    tools.append(search_brave_tool)
else:
    from app.tooling.tools.duckduckgo_search import duckduckgo_search_tool

    tools.append(duckduckgo_search_tool)


if config_manager.get("plugins.gmail.activate", False):
    from app.tooling.tools.gmail_toolkit import gmail_tools

    tools.extend(gmail_tools)

if config_manager.get("plugins.gcalendar.activate", False):
    from app.tooling.tools.gcalendar_toolkit import gcalendar_tools

    tools.extend(gcalendar_tools)

if config_manager.get("plugins.github.activate", False):
    from app.tooling.tools.github_toolkit import github_tools

    tools.extend(github_tools)

if config_manager.get("plugins.slack.activate", False):
    from app.tooling.tools.slack_toolkit import slack_tools

    tools.extend(slack_tools)

# Load MCP tools if enabled
_mcp_tools_loaded = False

tool_lookup: dict[str, Callable] = {}


def sync_tools_with_database():
    """
    Synchronize the tools database with the currently active tools.
    - Add new tools that are active but not in database
    - Remove tools that are in database but no longer active
    - Update existing tools if their descriptions changed
    """
    log_info("Synchronizing tools with database...")

    # Get currently active tools
    active_tools = {}
    for tool in tools:
        active_tools[tool.name] = {"name": tool.name, "description": tool.description}

    log_debug(f"DEBUG: Found {len(active_tools)} active tools:")
    for name in active_tools.keys():
        log_debug(f"  - '{name}'")

    # Get existing tools from database
    try:
        existing_items = store.retrieve_items(("tools",), limit=4000)  # Get all tools
        existing_tools = {item.key: item.value for item in existing_items}
        log_debug(f"DEBUG: Found {len(existing_tools)} existing tools in database:")
        for name in existing_tools.keys():
            log_debug(f"  - '{name}'")
    except Exception as e:
        log_error(f"Error getting existing tools from database: {e}")
        existing_tools = {}

    # Find tools to add (active but not in database)
    tools_to_add = []
    for name, tool_data in active_tools.items():
        if name not in existing_tools:
            tools_to_add.append((name, tool_data))
        elif existing_tools[name].get("description") != tool_data["description"]:
            # Tool exists but description changed - update it
            log_info(f"Updating tool '{name}' with new description")
            store.put(("tools",), name, tool_data, ["name", "description"])

    # Find tools to remove (in database but not active)
    tools_to_remove = []
    for name in existing_tools.keys():
        if name not in active_tools:
            tools_to_remove.append(name)
            log_debug(f"DEBUG: Will remove '{name}' (not in active tools)")

    # Add new tools
    for name, tool_data in tools_to_add:
        log_info(f"Adding new tool to database: {name}")
        store.put(("tools",), name, tool_data, ["name", "description"])

    # Remove inactive tools
    for name in tools_to_remove:
        log_info(f"Removing inactive tool from database: {name}")
        store.delete(("tools",), name)

    log_info(f"Tool synchronization complete. Added: {len(tools_to_add)}, Removed: {len(tools_to_remove)}")


async def load_mcp_tools_async():
    """DEPRECATED: MCP tools are now loaded by ToolingService.
    
    This function is kept for backwards compatibility but does nothing.
    All MCP tool loading is handled by app.tooling.tools_manager.ToolsManager
    via app.services.tooling_service.ToolingService.
    """
    log_debug("load_mcp_tools_async() called - MCP tools are loaded by ToolingService")


async def reload_mcp_servers():
    """Reload MCP servers from configuration and restart connections."""
    global _mcp_tools_loaded

    try:
        from app.tooling.mcp import mcp_client_manager

        log_info("Reloading MCP servers...")

        # Remove existing MCP tools from the tools list and lookup
        mcp_tool_names = []
        if mcp_client_manager.is_initialized:
            current_mcp_tools = mcp_client_manager.get_tools()
            mcp_tool_names = [tool.name for tool in current_mcp_tools]

        # Remove MCP tools from global tools list
        global tools
        tools = [tool for tool in tools if tool.name not in mcp_tool_names]

        # Remove MCP tools from lookup
        for tool_name in mcp_tool_names:
            tool_lookup.pop(tool_name, None)

        # Reset the loaded flag
        _mcp_tools_loaded = False

        # Close existing client connections
        await mcp_client_manager.close()

        # Reload tools from configuration
        await load_mcp_tools_async()

        log_info("MCP servers reloaded successfully")

    except Exception as e:
        log_error(f"Failed to reload MCP servers: {e}")


def reload_mcp_servers_sync():
    """Synchronous wrapper for reloading MCP servers."""
    try:
        import asyncio

        # Check if we're in an event loop
        try:
            asyncio.get_running_loop()
            # We're in an async context, create a task
            asyncio.create_task(reload_mcp_servers())
            log_info("MCP server reload scheduled asynchronously")
        except RuntimeError:
            # No event loop running, create one
            asyncio.run(reload_mcp_servers())

    except Exception as e:
        log_error(f"Failed to reload MCP servers synchronously: {e}")


# NOTE: MCP tools are now loaded by the ToolingService
# DO NOT load at module import time to avoid initialization order issues
# The ToolingService will handle MCP initialization properly


# Build tool lookup table
for tool in tools:
    name = tool.name
    description = tool.description
    # Add tool to hash table
    tool_lookup[name] = tool

# Note: sync_tools_with_database() will be called at the end of module loading


async def get_tools_async(query: str, top_k: int = 10) -> list[Callable]:
    """
    Async version of get_tools that ensures MCP tools are loaded.

    Args:
        query: Text to search for relevant tools
        top_k: Number of tools to return (default 5)

    Returns:
        List of matching tool functions including MCP tools
    """
    # Ensure MCP tools are loaded
    await load_mcp_tools_async()

    # Use the regular get_tools function
    return get_tools(query, top_k)


def ensure_mcp_tools_loaded():
    """DEPRECATED: MCP tools are now loaded by ToolingService.
    
    This function is kept for backwards compatibility but does nothing.
    All MCP tool loading is handled by app.tooling.tools_manager.ToolsManager
    via app.services.tooling_service.ToolingService.
    """
    pass  # ToolingService handles this now


def get_tools(query: str, top_k: int = 10) -> list[Callable]:
    """
    Search for relevant tools based on input text.

    Args:
        query: Text to search for relevant tools
        top_k: Number of tools to return (default 5)

    Returns:
        List of matching tool functions
    """
    # Try to ensure MCP tools are loaded if not already
    ensure_mcp_tools_loaded()

    # Search vector store
    results = store.search(("tools",), query=query, limit=top_k)

    log_info(f"Found {len(results)} tools matching query '{query}': {[result.value for result in results]}")

    # Get unique tool names from results
    tool_names = {result.key for result in results}
    # Return corresponding tool functions

    # Always include always_active_tools
    # Ensure they are not duplicated by mistake
    result_tools = [tool_lookup[name] for name in tool_names if name in tool_lookup]
    for tool in always_active_tools:
        if tool not in result_tools:
            result_tools.append(tool)
    return result_tools


# Tool management functions - exposed for external use
def get_mcp_status():
    """Get the current status of MCP integration."""
    try:
        from app.tooling.mcp import mcp_client_manager

        # Count MCP tools
        mcp_tool_count = 0
        mcp_tool_names = []
        if mcp_client_manager.is_initialized:
            current_mcp_tools = mcp_client_manager.get_tools()
            mcp_tool_count = len(current_mcp_tools)
            mcp_tool_names = [tool.name for tool in current_mcp_tools]

        return {
            "enabled": config_manager.get("mcp.enabled", True),
            "initialized": mcp_client_manager.is_initialized,
            "tools_loaded": _mcp_tools_loaded,
            "tool_count": mcp_tool_count,
            "tool_names": mcp_tool_names,
            "servers_configured": list(config_manager.get("mcp.servers", {}).keys()),
        }
    except Exception as e:
        log_error(f"Failed to get MCP status: {e}")
        return {
            "enabled": config_manager.get("mcp.enabled", True),
            "initialized": False,
            "tools_loaded": False,
            "tool_count": 0,
            "tool_names": [],
            "servers_configured": [],
            "error": str(e),
        }


# NOTE: Tool synchronization is now handled by the ToolingService
# DO NOT sync at module import time to avoid removing MCP tools prematurely
# The ToolingService will:
# 1. Load all tools (core + plugins + MCP)
# 2. THEN sync with database
# This ensures no tools are incorrectly removed from the database
