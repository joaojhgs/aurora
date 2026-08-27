"""Regression tests for concurrent SQLite migration application."""

from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path

import aiosqlite
import pytest

from app.services.db.migration_manager import MigrationManager


class _BarrierMigrationManager(MigrationManager):
    """Synchronize runners after their initial applied-version snapshot."""

    def __init__(self, db_path: str, migrations_dir: str, barrier: asyncio.Barrier):
        super().__init__(db_path, migrations_dir)
        self._barrier = barrier

    async def get_applied_migrations(self) -> list[str]:
        applied = await super().get_applied_migrations()
        await asyncio.wait_for(self._barrier.wait(), timeout=5)
        return applied


def test_split_sql_script_handles_compact_statements_quotes_comments_and_triggers():
    """Compact semicolon-delimited scripts split without breaking SQL string/trigger bodies."""

    script = (
        "CREATE TABLE compact_events (id INTEGER PRIMARY KEY, value TEXT); "
        "INSERT INTO compact_events (id, value) VALUES (1, 'semi;colon'); "
        "-- line comment; with semicolon\n"
        "CREATE TABLE compact_audit (id INTEGER, value TEXT); "
        "CREATE TRIGGER compact_events_audit "
        "AFTER INSERT ON compact_events "
        "BEGIN "
        "INSERT INTO compact_audit (id, value) VALUES (new.id, new.value); "
        "UPDATE compact_audit SET value = value WHERE id = new.id; "
        "END; "
        "INSERT INTO compact_events (id, value) VALUES (2, 'triggered');"
    )

    statements = MigrationManager._split_sql_script(script)

    assert len(statements) == 5
    assert statements[0] == "CREATE TABLE compact_events (id INTEGER PRIMARY KEY, value TEXT);"
    assert statements[1] == "INSERT INTO compact_events (id, value) VALUES (1, 'semi;colon');"
    assert statements[2].startswith("-- line comment; with semicolon\nCREATE TABLE compact_audit")
    assert statements[3].startswith("CREATE TRIGGER compact_events_audit")
    assert statements[3].endswith("END;")
    assert statements[4] == "INSERT INTO compact_events (id, value) VALUES (2, 'triggered');"


@pytest.mark.asyncio
async def test_compact_multi_statement_migration_applies_successfully(tmp_path: Path):
    """A migration can contain multiple statements on one physical line."""

    migrations_dir = tmp_path / "migrations"
    migrations_dir.mkdir()
    (migrations_dir / "001_compact.sql").write_text(
        (
            "CREATE TABLE compact_events (id INTEGER PRIMARY KEY, value TEXT); "
            "INSERT INTO compact_events (id, value) VALUES (1, 'semi;colon'); "
            "CREATE TABLE compact_audit (id INTEGER, value TEXT); "
            "CREATE TRIGGER compact_events_audit "
            "AFTER INSERT ON compact_events "
            "BEGIN "
            "INSERT INTO compact_audit (id, value) VALUES (new.id, new.value); "
            "END; "
            "INSERT INTO compact_events (id, value) VALUES (2, 'triggered');"
        ),
        encoding="utf-8",
    )
    db_path = str(tmp_path / "aurora.db")
    manager = MigrationManager(db_path, str(migrations_dir))

    await manager.run_migrations()

    async with aiosqlite.connect(db_path) as db:
        cursor = await db.execute("SELECT id, value FROM compact_events ORDER BY id")
        assert await cursor.fetchall() == [(1, "semi;colon"), (2, "triggered")]
        cursor = await db.execute("SELECT id, value FROM compact_audit")
        assert await cursor.fetchall() == [(2, "triggered")]


@pytest.mark.asyncio
async def test_concurrent_migration_runners_apply_version_once(tmp_path: Path):
    """Concurrent service startup must serialize the claim for each migration version."""

    migrations_dir = tmp_path / "migrations"
    migrations_dir.mkdir()
    (migrations_dir / "001_race.sql").write_text(
        """
        CREATE TABLE race_table (
            id INTEGER PRIMARY KEY,
            value TEXT NOT NULL
        );
        INSERT INTO race_table (id, value) VALUES (1, 'applied');
        """,
        encoding="utf-8",
    )
    db_path = str(tmp_path / "aurora.db")
    await MigrationManager(db_path, str(migrations_dir)).initialize_migration_table()
    barrier = asyncio.Barrier(2)
    managers = [
        _BarrierMigrationManager(db_path, str(migrations_dir), barrier),
        _BarrierMigrationManager(db_path, str(migrations_dir), barrier),
    ]

    results = await asyncio.gather(
        *(manager.run_migrations() for manager in managers),
        return_exceptions=True,
    )

    assert not [result for result in results if isinstance(result, Exception)]
    async with aiosqlite.connect(db_path) as db:
        cursor = await db.execute("SELECT COUNT(*) FROM migrations WHERE version = '001'")
        assert (await cursor.fetchone())[0] == 1
        cursor = await db.execute("SELECT value FROM race_table WHERE id = 1")
        assert (await cursor.fetchone())[0] == "applied"


@pytest.mark.asyncio
async def test_failed_migration_rolls_back_schema_and_version(tmp_path: Path):
    """A statement failure must not leave partial schema or a migration ledger row."""

    migrations_dir = tmp_path / "migrations"
    migrations_dir.mkdir()
    (migrations_dir / "001_partial_failure.sql").write_text(
        """
        CREATE TABLE partially_applied (
            id INTEGER PRIMARY KEY
        );
        INSERT INTO missing_table (id) VALUES (1);
        """,
        encoding="utf-8",
    )
    db_path = str(tmp_path / "aurora.db")
    manager = MigrationManager(db_path, str(migrations_dir))

    with pytest.raises(sqlite3.OperationalError):
        await manager.run_migrations()

    async with aiosqlite.connect(db_path) as db:
        cursor = await db.execute("SELECT COUNT(*) FROM migrations WHERE version = '001'")
        assert (await cursor.fetchone())[0] == 0
        cursor = await db.execute(
            """
            SELECT COUNT(*)
            FROM sqlite_master
            WHERE type = 'table'
              AND name = 'partially_applied'
            """
        )
        assert (await cursor.fetchone())[0] == 0
