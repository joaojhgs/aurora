from modules.langgraph.tools.resume_tts import resume_tts_tool
from modules.langgraph.tools.stop_tts import stop_tts_tool

from modules.langgraph.tools.upsert_memory import upsert_memory_tool
from modules.langgraph.tools.current_screen import current_screen_tool

from modules.langgraph.memory_store import store
import os
from typing import List, Dict, Callable

print("\nInitializing all tools and plugins...\n")

# Export all tools to bind to LLM
tools = [upsert_memory_tool, current_screen_tool, resume_tts_tool, stop_tts_tool]

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

if(os.environ['GMAIL_ACTIVATE_PLUGIN'] == "true"):
    from modules.langgraph.tools.gmail_toolkit import gmail_tools
    tools.extend(gmail_tools)

if(os.environ['GCALENDAR_ACTIVATE_PLUGIN'] == "true"):
    from modules.langgraph.tools.gcalendar_toolkit import gcalendar_tools
    tools.extend(gcalendar_tools)

if(os.environ['GITHUB_ACTIVATE_PLUGIN'] == "true"):
    from modules.langgraph.tools.github_toolkit import github_tools
    tools.extend(github_tools)

tool_lookup: Dict[str, Callable] = {}

for tool in tools:
    name = tool.name
    description = tool.description
    # Add tool to hash table
    tool_lookup[name] = tool
    # Add tool to vector store indexed by name and description
    store.put(("tools"), name, {"name": name, "description": description}, ["name", "description"])


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
        ("tools"),
        query=query,
        limit=top_k
    )
    
    # Get unique tool names from results
    tool_names = set(result.key for result in results)
    # Return corresponding tool functions
    return [tool_lookup[name] for name in tool_names]