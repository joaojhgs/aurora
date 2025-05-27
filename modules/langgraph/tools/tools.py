from modules.langgraph.tools.resume_tts import resume_tts_tool
from modules.langgraph.tools.stop_tts import stop_tts_tool

from modules.langgraph.tools.upsert_memory import upsert_memory_tool
from modules.langgraph.tools.current_screen import current_screen_tool

from modules.langgraph.memory_store import store
import os
from typing import List, Dict, Callable

print("\nInitializing all tools and plugins...\n")

# Make memory upsert is always active so that the chatbot can always store something new it deems worthwhile
always_active_tools = [upsert_memory_tool]

# Export all tools to bind to LLM
tools = [current_screen_tool, resume_tts_tool, stop_tts_tool]

# Only import if plugin is activated

if(os.environ['JIRA_ACTIVATE_PLUGIN'] == "true"):
    from modules.langgraph.tools.jira_toolkit import jira_tools
    tools.extend(jira_tools)

if(os.environ['OPENRECALL_ACTIVATE_PLUGIN'] == 'true'):
    from modules.langgraph.tools.openrecall_search import openrecall_search_tool
    tools.append(openrecall_search_tool)

if(os.environ['BRAVE_SEARCH_ACTIVATE_PLUGIN'] == 'true'):
    from modules.langgraph.tools.brave_search import search_brave_tool
    tools.append(search_brave_tool)
else:
    from modules.langgraph.tools.duckduckgo_search import duckduckgo_search_tool
    tools.append(duckduckgo_search_tool)


if(os.environ['GMAIL_ACTIVATE_PLUGIN'] == "true"):
    from modules.langgraph.tools.gmail_toolkit import gmail_tools
    tools.extend(gmail_tools)

if(os.environ['GCALENDAR_ACTIVATE_PLUGIN'] == "true"):
    from modules.langgraph.tools.gcalendar_toolkit import gcalendar_tools
    tools.extend(gcalendar_tools)

if(os.environ['GITHUB_ACTIVATE_PLUGIN'] == "true"):
    from modules.langgraph.tools.github_toolkit import github_tools
    tools.extend(github_tools)

if(os.environ['SLACK_ACTIVATE_PLUGIN'] == "true"):
    from modules.langgraph.tools.slack_toolkit import slack_tools
    tools.extend(slack_tools)

tool_lookup: Dict[str, Callable] = {}


def sync_tools_with_database():
    """
    Synchronize the tools database with the currently active tools.
    - Add new tools that are active but not in database
    - Remove tools that are in database but no longer active  
    - Update existing tools if their descriptions changed
    """
    print("Synchronizing tools with database...")
    
    # Get currently active tools
    active_tools = {}
    for tool in tools:
        active_tools[tool.name] = {
            "name": tool.name,
            "description": tool.description
        }
    
    print(f"DEBUG: Found {len(active_tools)} active tools:")
    for name in active_tools.keys():
        print(f"  - '{name}'")
    
    # Get existing tools from database
    try:
        existing_items = store.list(("tools",), limit=1000)  # Get all tools
        existing_tools = {item.key: item.value for item in existing_items}
        print(f"DEBUG: Found {len(existing_tools)} existing tools in database:")
        for name in existing_tools.keys():
            print(f"  - '{name}'")
    except Exception as e:
        print(f"Error getting existing tools from database: {e}")
        existing_tools = {}
    
    # Find tools to add (active but not in database)
    tools_to_add = []
    for name, tool_data in active_tools.items():
        if name not in existing_tools:
            tools_to_add.append((name, tool_data))
        elif existing_tools[name].get("description") != tool_data["description"]:
            # Tool exists but description changed - update it
            print(f"Updating tool '{name}' with new description")
            store.put(("tools",), name, tool_data, ["name", "description"])
    
    # Find tools to remove (in database but not active)
    tools_to_remove = []
    for name in existing_tools.keys():
        if name not in active_tools:
            tools_to_remove.append(name)
            print(f"DEBUG: Will remove '{name}' (not in active tools)")
    
    # Add new tools
    for name, tool_data in tools_to_add:
        print(f"Adding new tool to database: {name}")
        store.put(("tools",), name, tool_data, ["name", "description"])
    
    # Remove inactive tools
    for name in tools_to_remove:
        print(f"Removing inactive tool from database: {name}")
        store.delete(("tools",), name)
    
    print(f"Tool synchronization complete. Added: {len(tools_to_add)}, Removed: {len(tools_to_remove)}")


# Build tool lookup table and sync with database
for tool in tools:
    name = tool.name
    description = tool.description
    # Add tool to hash table
    tool_lookup[name] = tool

# Synchronize tools with database
sync_tools_with_database()


def get_tools(query: str, top_k: int = 5) -> List[Callable]:
    """
    Search for relevant tools based on input text.
    
    Args:
        query: Text to search for relevant tools
        top_k: Number of tools to return (default 3)
        
    Returns:
        List of matching tool functions
    """
    
    # Search vector store
    results = store.search(
        ("tools",),
        query=query,
        limit=top_k
    )
    
    print(f"Found {len(results)} tools matching query '{query}': {[result.value for result in results]}")

    # Get unique tool names from results
    tool_names = set(result.key for result in results)
    # Return corresponding tool functions
    
    # Always include always_active_tools
    # Ensure they are not duplicated by mistake
    result_tools = [tool_lookup[name] for name in tool_names if name in tool_lookup]
    for tool in always_active_tools:
        if tool not in result_tools:
            result_tools.append(tool)
    return result_tools