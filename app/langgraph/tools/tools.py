from typing import Callable

from app.config.config_manager import config_manager
from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.langgraph.memory_store import store

# Pomodoro tools
from app.langgraph.tools.pomodoro_tool import (
    pomodoro_status_tool,
    start_pomodoro_tool,
    stop_pomodoro_tool,
)
from app.langgraph.tools.resume_tts import resume_tts_tool

# Scheduler tools
from app.langgraph.tools.scheduler_tool import (
    cancel_scheduled_task_tool,
    list_scheduled_tasks_tool,
    schedule_task_tool,
)
from app.langgraph.tools.stop_tts import stop_tts_tool
from app.langgraph.tools.upsert_memory import upsert_memory_tool

log_info("Initializing all tools and plugins...\n")

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
    from app.langgraph.tools.current_screen import current_screen_tool

    tools.append(current_screen_tool)

if config_manager.get("plugins.jira.activate", False):
    from app.langgraph.tools.jira_toolkit import jira_tools

    tools.extend(jira_tools)

if config_manager.get("plugins.openrecall.activate", False):
    from app.langgraph.tools.openrecall_search import openrecall_search_tool

    tools.append(openrecall_search_tool)

if config_manager.get("plugins.brave_search.activate", False):
    from app.langgraph.tools.brave_search import search_brave_tool

    tools.append(search_brave_tool)
else:
    from app.langgraph.tools.duckduckgo_search import duckduckgo_search_tool

    tools.append(duckduckgo_search_tool)


if config_manager.get("plugins.gmail.activate", False):
    from app.langgraph.tools.gmail_toolkit import gmail_tools

    tools.extend(gmail_tools)

if config_manager.get("plugins.gcalendar.activate", False):
    from app.langgraph.tools.gcalendar_toolkit import gcalendar_tools

    tools.extend(gcalendar_tools)

if config_manager.get("plugins.github.activate", False):
    from app.langgraph.tools.github_toolkit import github_tools

    tools.extend(github_tools)

if config_manager.get("plugins.slack.activate", False):
    from app.langgraph.tools.slack_toolkit import slack_tools

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
    """Load MCP tools asynchronously and add them to the tool system."""
    global _mcp_tools_loaded

    if not config_manager.get("mcp.enabled", True) or _mcp_tools_loaded:
        return

    try:
        from app.langgraph.mcp_client import get_mcp_tools, initialize_mcp

        # Initialize MCP client first with timeout
        log_info("Initializing MCP client...")

        # Use asyncio.timeout for better error handling
        import asyncio

        try:
            log_debug("Starting MCP initialization with 60 second timeout...")
            async with asyncio.timeout(60):  # 60 second timeout for MCP initialization
                await initialize_mcp()
            log_debug("MCP initialization completed successfully")
        except asyncio.TimeoutError:
            log_error("MCP initialization timed out - some servers may require authentication")
            log_warning("Check MCP server configurations and ensure servers are accessible")
            return
        except Exception as e:
            log_error(f"MCP initialization failed: {e}")
            import traceback

            log_debug(f"MCP initialization full traceback:\n{traceback.format_exc()}")
            return

        # Then get the tools
        log_debug("Getting MCP tools from client...")
        mcp_tools = await get_mcp_tools()
        log_debug(f"Retrieved {len(mcp_tools) if mcp_tools else 0} MCP tools")

        if mcp_tools:
            # Add MCP tools to the global tools list and lookup
            for tool in mcp_tools:
                if tool.name not in tool_lookup:
                    tools.append(tool)
                    tool_lookup[tool.name] = tool

            log_info(f"Added {len(mcp_tools)} MCP tools to tool system")
            # Resync database with new tools
            sync_tools_with_database()
            _mcp_tools_loaded = True
        else:
            log_info("No MCP tools were loaded - this may be normal if servers require authentication")

    except Exception as e:
        log_error(f"Failed to load MCP tools asynchronously: {e}")
        import traceback

        log_debug(f"MCP tools loading traceback: {traceback.format_exc()}")


async def reload_mcp_servers():
    """Reload MCP servers from configuration and restart connections."""
    global _mcp_tools_loaded

    try:
        from app.langgraph.mcp_client import mcp_client_manager

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


if config_manager.get("mcp.enabled", True):
    try:
        import asyncio

        log_info("Loading MCP tools...")

        # Check if we're in an event loop
        try:
            loop = asyncio.get_running_loop()
            # We're in an async context, schedule the coroutine
            # Don't create a task here as it can cause TaskGroup issues
            # Instead, we'll load tools on-demand when needed
            log_debug("MCP tools will be loaded on-demand in async context")
        except RuntimeError:
            # We're not in an event loop, start one with proper error handling
            try:
                asyncio.run(load_mcp_tools_async())
            except Exception as e:
                log_error(f"Failed to initialize MCP tools at startup: {e}")
                log_info("MCP tools will be loaded on-demand when first requested")

    except ImportError as e:
        log_warning(f"MCP integration not available: {e}")
    except Exception as e:
        log_error(f"Failed to setup MCP tools: {e}")
        log_info("MCP tools will be loaded on-demand when first requested")


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
    """
    Attempt to load MCP tools if they haven't been loaded yet.
    This is a fallback for synchronous contexts.
    """

    if not config_manager.get("mcp.enabled", True) or _mcp_tools_loaded:
        return

    try:
        import asyncio

        # Try to run in the current event loop if it exists
        try:
            asyncio.get_running_loop()
            # We're in an async context but this is a sync call
            # We can't await here, so we'll skip for now
            log_debug("MCP tools loading skipped - in async context, use get_tools_async() instead")
            return
        except RuntimeError:
            # No event loop running, we can create one
            asyncio.run(load_mcp_tools_async())

    except Exception as e:
        log_debug(f"Could not load MCP tools in sync context: {e}")


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
        from app.langgraph.mcp_client import mcp_client_manager

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


# Initialize tool synchronization after all functions are defined
if _mcp_tools_loaded:
    try:
        sync_tools_with_database()
        log_info("MCP tools synchronized with database successfully")
    except Exception as e:
        log_error(f"Failed to sync MCP tools with database: {e}")
else:
    # Always sync the initial tools regardless of MCP
    sync_tools_with_database()
