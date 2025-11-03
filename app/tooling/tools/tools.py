from typing import Callable

from app.config.config_manager import config_manager
from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.messaging import MessageBus

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


async def sync_tools_with_database(bus: MessageBus):
    """
    Synchronize the tools database with the currently active tools.
    - Add new tools that are active but not in database
    - Remove tools that are in database but no longer active
    - Update existing tools if their descriptions changed
    """
    log_info("Synchronizing tools with database...")

    # Use injected bus (service-provided)
    if not bus:
        log_error("Bus not available for tool synchronization")
        return

    # Get currently active tools
    active_tools = {}
    for tool in tools:
        active_tools[tool.name] = {"name": tool.name, "description": tool.description}

    log_debug(f"DEBUG: Found {len(active_tools)} active tools:")
    for name in active_tools.keys():
        log_debug(f"  - '{name}'")

    # Get existing tools from database via bus
    try:
        from app.db.service import RAGDeleteCommand, RAGListQuery, RAGStoreCommand
        from app.messaging import DBTopics

        result = await bus.request(
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
            await bus.publish(
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
        await bus.publish(
            DBTopics.RAG_STORE,
            RAGStoreCommand(namespace=("tools",), key=name, value=tool_data, index=["name", "description"]),
            event=False,
        )

    # Remove inactive tools via bus
    for name in tools_to_remove:
        log_info(f"Removing inactive tool from database: {name}")
        await bus.publish(
            DBTopics.RAG_DELETE,
            RAGDeleteCommand(namespace=("tools",), key=name),
            event=False,
        )

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


async def get_tools(query: str, top_k: int = 10) -> list[Callable]:
    """
    Search for relevant tools based on input text using RAG via bus.

    Args:
        query: Text to search for relevant tools
        top_k: Number of tools to return (default 5)

    Returns:
        List of matching tool functions
    """
    # Ensure MCP tools are loaded
    ensure_mcp_tools_loaded()

    # NOTE: This function should be called by ToolingService which owns the bus.
    # To avoid accidental global runtime access in processes mode, return empty
    # and let ToolingService perform RAG and map names to tools.
    log_warning("get_tools should be invoked by ToolingService; returning empty list")
    return []


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
        }


def ensure_mcp_tools_loaded():
    """DEPRECATED: MCP tools are now loaded by ToolingService."""
    pass
