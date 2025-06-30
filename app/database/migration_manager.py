"""
Migration management for Aurora database.
Handles versioned database schema changes.
"""

import os
import re
from pathlib import Path
from typing import List, Tuple

import aiosqlite

from app.helpers.aurora_logger import log_debug, log_error, log_info


class MigrationManager:
    """Manages database migrations"""

    def __init__(self, db_path: str, migrations_dir: str):
        self.db_path = db_path
        self.migrations_dir = Path(migrations_dir)
        self.migrations_dir.mkdir(parents=True, exist_ok=True)

    async def initialize_migration_table(self):
        """Create the migrations table if it doesn't exist"""
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS migrations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    version TEXT UNIQUE NOT NULL,
                    filename TEXT NOT NULL,
                    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """
            )
            await db.commit()

    def get_migration_files(self) -> List[Tuple[str, str]]:
        """Get all migration files sorted by version"""
        migration_files = []

        if not self.migrations_dir.exists():
            return migration_files

        for file_path in self.migrations_dir.glob("*.sql"):
            # Expected format: 001_initial_schema.sql
            match = re.match(r"^(\d+)_(.+)\.sql$", file_path.name)
            if match:
                version = match.group(1)
                migration_files.append((version, str(file_path)))

        # Sort by version number
        migration_files.sort(key=lambda x: int(x[0]))
        return migration_files

    async def get_applied_migrations(self) -> List[str]:
        """Get list of applied migration versions"""
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute("SELECT version FROM migrations ORDER BY version")
            rows = await cursor.fetchall()
            return [row[0] for row in rows]

    async def apply_migration(self, version: str, filename: str):
        """Apply a single migration"""
        log_info(f"Applying migration {version}: {os.path.basename(filename)}")

        with open(filename, "r") as f:
            migration_sql = f.read()

        async with aiosqlite.connect(self.db_path) as db:
            # Execute migration SQL
            await db.executescript(migration_sql)

            # Record migration as applied
            await db.execute(
                "INSERT INTO migrations (version, filename) VALUES (?, ?)",
                (version, os.path.basename(filename)),
            )
            await db.commit()

    async def run_migrations(self):
        """Run all pending migrations"""
        await self.initialize_migration_table()

        migration_files = self.get_migration_files()
        applied_migrations = await self.get_applied_migrations()

        pending_migrations = [
            (version, filename)
            for version, filename in migration_files
            if version not in applied_migrations
        ]

        if not pending_migrations:
            log_info("No pending migrations")
            return

        log_info(f"Running {len(pending_migrations)} pending migrations...")

        for version, filename in pending_migrations:
            await self.apply_migration(version, filename)

        log_info("All migrations completed successfully")

    def create_migration(self, name: str, content: str) -> str:
        """Create a new migration file"""
        # Get next version number
        existing_migrations = self.get_migration_files()
        if existing_migrations:
            last_version = max(int(version) for version, _ in existing_migrations)
            next_version = f"{last_version + 1:03d}"
        else:
            next_version = "001"

        # Create filename
        safe_name = re.sub(r"[^a-zA-Z0-9_]", "_", name.lower())
        filename = f"{next_version}_{safe_name}.sql"
        file_path = self.migrations_dir / filename

        # Write migration content
        with open(file_path, "w") as f:
            f.write(f"-- Migration {next_version}: {name}\n")
            f.write(f"-- Created at: {Path().cwd()}\n\n")
            f.write(content)

        log_info(f"Created migration: {filename}")
        return str(file_path)
