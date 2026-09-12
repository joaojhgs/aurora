"""Regression tests for Aurora's shared SQLite contention policy."""

import asyncio
from datetime import datetime, timedelta
from typing import cast

import aiosqlite
import pytest

from app.services.db.manager import DatabaseManager
from app.services.db.models import CronJob, JobStatus, ScheduleType
from app.services.db.scheduler_db_service import SchedulerDatabaseService
from app.services.db.sqlite_connection import (
    SQLITE_BUSY_TIMEOUT_MS,
    close_database,
    database_connection,
)
from app.shared.contracts.models.db import DBReconcileToolIdentityRequest


@pytest.mark.asyncio
async def test_database_connection_enables_wal_busy_timeout_and_foreign_keys(tmp_path):
    """Every Aurora connection carries the same durable concurrency policy."""

    db_path = tmp_path / "aurora.db"

    async with database_connection(db_path) as db:
        journal_mode = (await (await db.execute("PRAGMA journal_mode")).fetchone())[0]
        busy_timeout = (await (await db.execute("PRAGMA busy_timeout")).fetchone())[0]
        foreign_keys = (await (await db.execute("PRAGMA foreign_keys")).fetchone())[0]

    assert journal_mode == "wal"
    assert busy_timeout == SQLITE_BUSY_TIMEOUT_MS
    assert foreign_keys == 1


@pytest.mark.asyncio
async def test_scheduler_reads_continue_during_an_exclusive_wal_writer(tmp_path):
    """Scheduler polling must not collapse while another service is writing."""

    db_path = tmp_path / "aurora.db"
    service = SchedulerDatabaseService(str(db_path))
    await service.initialize()
    due_job = CronJob(
        id="due-job",
        name="Committed job",
        schedule_type=ScheduleType.ABSOLUTE,
        schedule_value="once",
        next_run_time=datetime.now() - timedelta(seconds=1),
        callback_module="tests.callbacks",
        callback_function="run",
        status=JobStatus.PENDING,
    )
    assert await service.add_job(due_job) is True

    writer = await aiosqlite.connect(db_path)
    try:
        await writer.execute("BEGIN EXCLUSIVE")
        await writer.execute(
            "UPDATE cron_jobs SET name = ? WHERE id = ?",
            ("Uncommitted name", due_job.id),
        )

        ready_jobs = await asyncio.wait_for(service.get_ready_jobs(), timeout=2)

        assert [job.id for job in ready_jobs] == [due_job.id]
        assert ready_jobs[0].name == "Committed job"
    finally:
        await writer.rollback()
        await writer.close()


@pytest.mark.asyncio
async def test_contending_writer_waits_for_lock_release_instead_of_failing(tmp_path):
    """Concurrent service writes wait within the shared timeout budget."""

    db_path = tmp_path / "aurora.db"
    async with database_connection(db_path) as db:
        await db.execute("CREATE TABLE writes (id TEXT PRIMARY KEY)")
        await db.commit()

    writer = await aiosqlite.connect(db_path)
    await writer.execute("BEGIN IMMEDIATE")
    await writer.execute("INSERT INTO writes (id) VALUES ('held')")

    async def write_after_release() -> None:
        async with database_connection(db_path) as db:
            await db.execute("INSERT INTO writes (id) VALUES ('waited')")
            await db.commit()

    waiting_write = asyncio.create_task(write_after_release())
    try:
        await asyncio.sleep(0.05)
        assert waiting_write.done() is False
        await writer.rollback()
        await asyncio.wait_for(waiting_write, timeout=2)
    finally:
        if not waiting_write.done():
            waiting_write.cancel()
        await writer.close()

    async with database_connection(db_path) as db:
        rows = await (await db.execute("SELECT id FROM writes ORDER BY id")).fetchall()
    assert rows == [("waited",)]


@pytest.mark.asyncio
async def test_database_context_cancellation_releases_writer_before_returning(tmp_path):
    """Cancelling a DB operation cannot leave SQLite's writer slot occupied."""

    db_path = tmp_path / "aurora.db"
    async with database_connection(db_path) as db:
        await db.execute("CREATE TABLE writes (id TEXT PRIMARY KEY)")
        await db.commit()

    writer_started = asyncio.Event()

    async def cancelled_writer() -> None:
        async with database_connection(db_path) as db:
            await db.execute("BEGIN IMMEDIATE")
            await db.execute("INSERT INTO writes (id) VALUES ('cancelled')")
            writer_started.set()
            await asyncio.Future()

    writer_task = asyncio.create_task(cancelled_writer())
    await asyncio.wait_for(writer_started.wait(), timeout=2)
    writer_task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await writer_task

    async with asyncio.timeout(2):
        async with database_connection(db_path) as db:
            await db.execute("INSERT INTO writes (id) VALUES ('after-cancel')")
            await db.commit()
            rows = await (await db.execute("SELECT id FROM writes ORDER BY id")).fetchall()

    assert rows == [("after-cancel",)]


@pytest.mark.asyncio
async def test_close_database_finishes_rollback_and_close_when_cancelled():
    """Cleanup itself is cancellation-safe, including a slow rollback."""

    rollback_started = asyncio.Event()
    release_rollback = asyncio.Event()

    class CleanupProbe:
        in_transaction = True
        rolled_back = False
        closed = False

        async def rollback(self) -> None:
            rollback_started.set()
            await release_rollback.wait()
            self.rolled_back = True
            self.in_transaction = False

        async def close(self) -> None:
            self.closed = True

    probe = CleanupProbe()
    cleanup_task = asyncio.create_task(close_database(cast(aiosqlite.Connection, probe)))
    await asyncio.wait_for(rollback_started.wait(), timeout=2)
    cleanup_task.cancel()
    release_rollback.set()
    with pytest.raises(asyncio.CancelledError):
        await cleanup_task

    assert probe.rolled_back is True
    assert probe.closed is True


@pytest.mark.asyncio
async def test_tool_identity_reconciliation_waits_for_contending_writer(tmp_path):
    """The startup identity transaction survives a short-lived competing writer."""

    db_path = tmp_path / "aurora.db"
    manager = DatabaseManager(str(db_path))
    await manager.initialize()
    request = DBReconcileToolIdentityRequest(
        canonical_global_tool_id="aurora-tool:v1:peer-a:Tooling:core.scheduler.daily-greeting",
        stable_peer_id="peer-a",
        tool_contract_id="core.scheduler.daily-greeting",
        source_kind="core",
        stable_source_id="core.scheduler",
        provider_tool_id="scheduler_daily_greeting_tool",
        share_group_id="core:scheduler",
        share_group_label="Scheduler",
        current_local_name="scheduler_daily_greeting_tool",
        legacy_global_tool_ids=["peer-a:local:Tooling:scheduler_daily_greeting_tool"],
    )

    writer = await aiosqlite.connect(db_path)
    await writer.execute("PRAGMA journal_mode = WAL")
    await writer.execute("BEGIN IMMEDIATE")
    waiting_reconcile = asyncio.create_task(manager.reconcile_tool_identity(request))
    try:
        await asyncio.sleep(0.05)
        assert waiting_reconcile.done() is False
        await writer.rollback()
        result = await asyncio.wait_for(waiting_reconcile, timeout=2)
    finally:
        if not waiting_reconcile.done():
            waiting_reconcile.cancel()
        await writer.close()

    assert result.success is True
