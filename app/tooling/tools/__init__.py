"""Tools package for Aurora.

Contains all tool implementations including core tools and plugin tools.
"""

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
from app.tooling.tools.tools import (
    always_active_tools,
    get_tools,
    sync_tools_with_database,
)
from app.tooling.tools.upsert_memory import upsert_memory_tool

__all__ = [
    # Core tools
    "resume_tts_tool",
    "stop_tts_tool",
    "schedule_task_tool",
    "list_scheduled_tasks_tool",
    "cancel_scheduled_task_tool",
    "start_pomodoro_tool",
    "stop_pomodoro_tool",
    "pomodoro_status_tool",
    "upsert_memory_tool",
    # Tool management functions
    "get_tools",
    "sync_tools_with_database",
    "always_active_tools",
]
