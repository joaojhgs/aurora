import asyncio
from typing import Optional

from langchain_community.tools import BraveSearch

from app.shared.config.interface import ConfigAPI

config_api = ConfigAPI()

# Lazy-initialized search tool
_search_brave_tool: BraveSearch | None = None
_tool_lock = asyncio.Lock()


async def async_get_brave_search_tool() -> BraveSearch | None:
    """Get Brave Search tool asynchronously with proper config loading.

    Uses await config_api.aget() to properly access config in async context.
    Thread-safe via asyncio.Lock.

    Returns:
        BraveSearch tool if API key is configured, None otherwise.
    """
    global _search_brave_tool
    async with _tool_lock:
        if _search_brave_tool is None:
            api_key = await config_api.aget("plugins.brave_search.api_key", None)
            if api_key:
                _search_brave_tool = BraveSearch.from_api_key(
                    api_key=api_key, search_kwargs={"count": 3}
                )
        return _search_brave_tool


def get_brave_search_tool_sync() -> BraveSearch | None:
    """Get Brave Search tool synchronously.

    Returns the cached tool if available, or None.
    Prefer async_get_brave_search_tool() for proper initialization.
    """
    return _search_brave_tool


# Backward compatibility: Expose as module-level variable
# Code should migrate to using async_get_brave_search_tool() instead
search_brave_tool = None
