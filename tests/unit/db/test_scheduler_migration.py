"""Scheduler DB migration tests."""

import aiosqlite
import pytest

from app.services.db.scheduler_db_service import SchedulerDatabaseService


@pytest.mark.asyncio
async def test_scheduler_typed_action_migration_is_idempotent_via_migration_table(tmp_path):
    """Running the migration manager twice leaves typed scheduler columns intact."""
    db_path = tmp_path / "scheduler.db"
    service = SchedulerDatabaseService(str(db_path))

    await service.initialize()
    await service.initialize()

    async with aiosqlite.connect(db_path) as db:
        cursor = await db.execute("PRAGMA table_info(cron_jobs)")
        columns = {row[1] for row in await cursor.fetchall()}
        assert {
            "action_kind",
            "action_spec",
            "action_spec_version",
            "prepared_binding",
            "policy_decision_id",
        }.issubset(columns)

        cursor = await db.execute(
            "SELECT COUNT(*) FROM migrations WHERE version = '008'"
        )
        assert (await cursor.fetchone())[0] == 1


@pytest.mark.asyncio
async def test_scheduler_typed_action_migration_preserves_not_null_callbacks(tmp_path):
    """The chosen compatibility path keeps legacy callback columns non-null."""
    db_path = tmp_path / "scheduler.db"
    service = SchedulerDatabaseService(str(db_path))
    await service.initialize()

    async with aiosqlite.connect(db_path) as db:
        cursor = await db.execute("PRAGMA table_info(cron_jobs)")
        columns = {row[1]: row for row in await cursor.fetchall()}

    assert columns["callback_module"][3] == 1
    assert columns["callback_function"][3] == 1
    assert columns["action_spec"][3] == 0
