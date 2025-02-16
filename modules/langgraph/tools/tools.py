from modules.langgraph.tools.brave_search import search_brave_tool
from modules.langgraph.tools.upsert_memory import upsert_memory_tool
from modules.langgraph.tools.openrecall_search import openrecall_search_tool
from modules.langgraph.tools.current_screen import current_screen_tool

# Export all tools to bind to LLM
tools = [search_brave_tool, upsert_memory_tool, openrecall_search_tool, current_screen_tool]