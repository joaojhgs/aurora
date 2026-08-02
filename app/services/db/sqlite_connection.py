"""Shared SQLite connection policy for Aurora's local database."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from os import fspath
from pathlib import Path

import aiosqlite

SQLITE_BUSY_TIMEOUT_MS = 30_000
SQLITE_CONNECT_TIMEOUT_SECONDS = SQLITE_BUSY_TIMEOUT_MS / 1_000


def _supports_wal(db_path: str | Path) -> bool:
    """Return whether the target is a persistent SQLite database."""

    target = fspath(db_path)
    return target != ":memory:" and not (target.startswith("file:") and "mode=memory" in target)


async def close_database(db: aiosqlite.Connection) -> None:
    """Rollback unfinished work and close a connection even during cancellation.

    SQLite has one writer slot. Letting task cancellation interrupt connection
    cleanup can strand that slot behind unrelated catalog work and delay pairing
    or reconnect operations.
    """

    async def cleanup() -> None:
        try:
            if db.in_transaction:
                await db.rollback()
        finally:
            await db.close()

    cleanup_task = asyncio.create_task(cleanup())
    try:
        await asyncio.shield(cleanup_task)
    except asyncio.CancelledError:
        await cleanup_task
        raise


async def open_database(
    db_path: str | Path,
    *,
    row_factory: object | None = None,
) -> aiosqlite.Connection:
    """Open an Aurora SQLite connection with one contention-safe policy."""

    db = await aiosqlite.connect(
        db_path,
        timeout=SQLITE_CONNECT_TIMEOUT_SECONDS,
    )
    try:
        await db.execute(f"PRAGMA busy_timeout = {SQLITE_BUSY_TIMEOUT_MS}")
        await db.execute("PRAGMA foreign_keys = ON")
        if _supports_wal(db_path):
            cursor = await db.execute("PRAGMA journal_mode")
            row = await cursor.fetchone()
            current_mode = str(row[0]).lower() if row else ""
            if current_mode != "wal":
                cursor = await db.execute("PRAGMA journal_mode = WAL")
                row = await cursor.fetchone()
                if not row or str(row[0]).lower() != "wal":
                    raise RuntimeError("Aurora SQLite database did not enter WAL mode")
        if row_factory is not None:
            db.row_factory = row_factory
        return db
    except BaseException:
        await close_database(db)
        raise


@asynccontextmanager
async def database_connection(
    db_path: str | Path,
    *,
    row_factory: object | None = None,
) -> AsyncIterator[aiosqlite.Connection]:
    """Yield a configured Aurora SQLite connection and always close it."""

    db = await open_database(db_path, row_factory=row_factory)
    try:
        yield db
    finally:
        await close_database(db)
