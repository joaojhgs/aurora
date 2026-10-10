"""Lifetime tracking for synchronous native provider operations."""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import Callable
from contextlib import suppress
from typing import Any

_worker_tasks: dict[int, set[asyncio.Task]] = {}
_stream_tasks: dict[int, set[asyncio.Task]] = {}


def _prune_done_task(
    registry: dict[int, set[asyncio.Task]], owner_id: int, task: asyncio.Task
) -> None:
    """Remove a completed task even when its enclosing coroutine is paused."""

    tasks = registry.get(owner_id)
    if tasks is None:
        return
    tasks.discard(task)
    if not tasks:
        registry.pop(owner_id, None)


def _track_task(registry: dict[int, set[asyncio.Task]], owner_id: int, task: asyncio.Task) -> None:
    registry.setdefault(owner_id, set()).add(task)
    task.add_done_callback(lambda completed: _prune_done_task(registry, owner_id, completed))


def provider_owner(instance: Any) -> Any:
    """Find the underlying provider behind a bound runnable when available."""

    seen: set[int] = set()
    current = instance
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        missing = object()
        if inspect.getattr_static(current, "bound", missing) is missing:
            return current
        bound = getattr(current, "bound", None)
        if bound is None or bound is current:
            return current
        current = bound
    return instance


async def run_native(
    provider: Any,
    function: Callable[..., Any],
    *args: Any,
    **kwargs: Any,
) -> Any:
    """Run blocking provider work and drain it when the caller is cancelled."""

    owner = provider_owner(provider)
    worker = asyncio.create_task(asyncio.to_thread(function, *args, **kwargs))
    _track_task(_worker_tasks, id(owner), worker)
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        with suppress(BaseException):
            await asyncio.shield(worker)
        raise
    finally:
        if worker.done():
            _prune_done_task(_worker_tasks, id(owner), worker)


async def drain_native(provider: Any) -> None:
    """Wait for all tracked blocking operations owned by a provider."""

    owner = provider_owner(provider)
    while streams := [task for task in _stream_tasks.get(id(owner), set()) if not task.done()]:
        for stream in streams:
            if not stream.done():
                stream.cancel()
        await asyncio.shield(asyncio.gather(*streams, return_exceptions=True))
    while workers := [task for task in _worker_tasks.get(id(owner), set()) if not task.done()]:
        await asyncio.shield(asyncio.gather(*workers, return_exceptions=True))


def _next_or_sentinel(iterator: Any, sentinel: object) -> Any:
    """Advance an iterator without leaking StopIteration through a Future."""

    return next(iterator, sentinel)


async def stream_native(
    provider: Any,
    iterator_factory: Callable[..., Any],
    *args: Any,
    **kwargs: Any,
):
    """Own a native iterator producer for the lifetime of an async consumer."""

    owner = provider_owner(provider)
    queue: asyncio.Queue[tuple[str, Any]] = asyncio.Queue(maxsize=1)
    sentinel = object()
    closing = False
    completed = False

    async def produce() -> None:
        nonlocal closing, completed
        iterator = None
        try:
            iterator = await run_native(provider, iterator_factory, *args, **kwargs)
            while True:
                chunk = await run_native(provider, _next_or_sentinel, iterator, sentinel)
                if chunk is sentinel:
                    await queue.put(("done", None))
                    completed = True
                    return
                await queue.put(("item", chunk))
        except BaseException as error:
            if not isinstance(error, asyncio.CancelledError):
                await queue.put(("error", error))
                completed = True
            raise
        finally:
            if not completed:
                closing = True
                with suppress(asyncio.QueueFull):
                    queue.put_nowait(("closed", None))
            close = getattr(iterator, "close", None)
            if callable(close):
                await run_native(provider, close)

    producer = asyncio.create_task(produce())
    _track_task(_stream_tasks, id(owner), producer)
    try:
        while True:
            kind, value = await queue.get()
            if closing:
                raise asyncio.CancelledError
            if kind == "done":
                break
            if kind == "closed":
                raise asyncio.CancelledError
            if kind == "error":
                raise value
            yield value
    finally:
        if not producer.done():
            producer.cancel()
        await asyncio.shield(asyncio.gather(producer, return_exceptions=True))
        _prune_done_task(_stream_tasks, id(owner), producer)
