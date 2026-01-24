import asyncio
from collections.abc import Coroutine
from typing import Any, Optional, Union


def run_async_in_thread(coro: Coroutine) -> asyncio.Task | Any | None:
    """
    Run an async coroutine, handling both sync and async calling contexts.

    - If called from within a running event loop: schedules as a task
    - If called from sync context: runs with asyncio.run()

    Args:
        coro: The coroutine to execute

    Returns:
        - asyncio.Task if scheduled in existing loop
        - The coroutine's return value if run with asyncio.run()
        - None if execution fails
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    # This conditional is now OUTSIDE the except block (was a bug before)
    if loop is not None and loop.is_running():
        # Already in async context - schedule as task
        return asyncio.create_task(coro)
    else:
        # Sync context - safe to use asyncio.run()
        return asyncio.run(coro)
