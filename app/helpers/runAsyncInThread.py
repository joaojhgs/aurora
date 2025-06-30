import asyncio


def run_async_in_thread(coro):
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        loop = None
        if loop and loop.is_running():
            # If already in an event loop, schedule as a task
            asyncio.create_task(coro)
        else:
            asyncio.run(coro)
