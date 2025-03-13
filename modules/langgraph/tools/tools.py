from modules.langgraph.tools.resume_tts import resume_tts_tool
from modules.langgraph.tools.stop_tts import stop_tts_tool

from modules.langgraph.tools.brave_search import search_brave_tool
from modules.langgraph.tools.upsert_memory import upsert_memory_tool
from modules.langgraph.tools.openrecall_search import openrecall_search_tool
from modules.langgraph.tools.current_screen import current_screen_tool
import os


# Export all tools to bind to LLM
tools = [search_brave_tool, upsert_memory_tool, openrecall_search_tool, current_screen_tool, resume_tts_tool, stop_tts_tool]

# Only import if plugin is activated
if(os.environ['JIRA_ACTIVATE_PLUGIN'] == "true"):
    from modules.langgraph.tools.jira_toolkit import jira_tools
    tools.extend(jira_tools)
