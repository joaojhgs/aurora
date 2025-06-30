"""
Main database manager for Aurora.
Handles all database operations using aiosqlite.
"""

import json
from datetime import date, datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

import aiosqlite

from app.helpers.aurora_logger import log_debug, log_error, log_info

from .migration_manager import MigrationManager
from .models import Message, MessageType


class DatabaseManager:
    """Main database manager for Aurora"""

    def __init__(self, db_path: str = None):
        if db_path is None:
            # Default to data directory in project root
            project_root = Path(__file__).parent.parent.parent
            data_dir = project_root / "data"
            data_dir.mkdir(exist_ok=True)
            db_path = str(data_dir / "aurora.db")

        self.db_path = db_path

        # Set up migrations
        migrations_dir = Path(__file__).parent / "migrations"
        self.migration_manager = MigrationManager(db_path, str(migrations_dir))

    async def initialize(self):
        """Initialize the database and run migrations"""
        log_info(f"Initializing database at: {self.db_path}")

        # Ensure database file exists
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)

        # Run migrations
        await self.migration_manager.run_migrations()

        log_info("Database initialization completed")

    async def store_message(self, message: Message) -> bool:
        """Store a message in the database"""
        try:
            async with aiosqlite.connect(self.db_path) as db:
                await db.execute(
                    """
                    INSERT INTO messages (
                        id, content, message_type, timestamp, 
                        session_id, metadata, source_type
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                    (
                        message.id,
                        message.content,
                        message.message_type.value,
                        message.timestamp.isoformat(),
                        message.session_id,
                        json.dumps(message.metadata) if message.metadata else None,
                        message.source_type,
                    ),
                )
                await db.commit()
                return True
        except Exception as e:
            log_error(f"Error storing message: {e}")
            return False

    async def get_messages_for_date(self, target_date: date = None) -> List[Message]:
        """Get all messages for a specific date (defaults to today)"""
        if target_date is None:
            target_date = date.today()

        # Calculate date range for the target date
        start_datetime = datetime.combine(target_date, datetime.min.time())
        end_datetime = datetime.combine(target_date, datetime.max.time())

        try:
            async with aiosqlite.connect(self.db_path) as db:
                db.row_factory = aiosqlite.Row
                cursor = await db.execute(
                    """
                    SELECT * FROM messages 
                    WHERE timestamp BETWEEN ? AND ?
                    ORDER BY timestamp ASC
                """,
                    (start_datetime.isoformat(), end_datetime.isoformat()),
                )

                rows = await cursor.fetchall()
                messages = []

                for row in rows:
                    message_data = dict(row)
                    # Parse metadata if present
                    if message_data["metadata"]:
                        message_data["metadata"] = json.loads(message_data["metadata"])

                    messages.append(Message.from_dict(message_data))

                return messages
        except Exception as e:
            log_error(f"Error retrieving messages for date {target_date}: {e}")
            return []

    async def get_recent_messages(self, limit: int = 50) -> List[Message]:
        """Get the most recent messages"""
        try:
            async with aiosqlite.connect(self.db_path) as db:
                db.row_factory = aiosqlite.Row
                cursor = await db.execute(
                    """
                    SELECT * FROM messages 
                    ORDER BY timestamp DESC 
                    LIMIT ?
                """,
                    (limit,),
                )

                rows = await cursor.fetchall()
                messages = []

                for row in rows:
                    message_data = dict(row)
                    # Parse metadata if present
                    if message_data["metadata"]:
                        message_data["metadata"] = json.loads(message_data["metadata"])

                    messages.append(Message.from_dict(message_data))

                # Return in chronological order (oldest first)
                return list(reversed(messages))
        except Exception as e:
            log_error(f"Error retrieving recent messages: {e}")
            return []

    async def get_message_by_id(self, message_id: str) -> Optional[Message]:
        """Get a specific message by ID"""
        try:
            async with aiosqlite.connect(self.db_path) as db:
                db.row_factory = aiosqlite.Row
                cursor = await db.execute("SELECT * FROM messages WHERE id = ?", (message_id,))
                row = await cursor.fetchone()

                if row:
                    message_data = dict(row)
                    if message_data["metadata"]:
                        message_data["metadata"] = json.loads(message_data["metadata"])
                    return Message.from_dict(message_data)

                return None
        except Exception as e:
            log_error(f"Error retrieving message {message_id}: {e}")
            return None

    async def delete_message(self, message_id: str) -> bool:
        """Delete a message by ID"""
        try:
            async with aiosqlite.connect(self.db_path) as db:
                await db.execute("DELETE FROM messages WHERE id = ?", (message_id,))
                await db.commit()
                return True
        except Exception as e:
            log_error(f"Error deleting message {message_id}: {e}")
            return False

    async def get_message_count_for_date(self, target_date: date = None) -> int:
        """Get the count of messages for a specific date"""
        if target_date is None:
            target_date = date.today()

        start_datetime = datetime.combine(target_date, datetime.min.time())
        end_datetime = datetime.combine(target_date, datetime.max.time())

        try:
            async with aiosqlite.connect(self.db_path) as db:
                cursor = await db.execute(
                    """
                    SELECT COUNT(*) FROM messages 
                    WHERE timestamp BETWEEN ? AND ?
                """,
                    (start_datetime.isoformat(), end_datetime.isoformat()),
                )

                result = await cursor.fetchone()
                return result[0] if result else 0
        except Exception as e:
            log_error(f"Error getting message count for date {target_date}: {e}")
            return 0

    async def cleanup_old_messages(self, days_to_keep: int = 30) -> int:
        """Remove messages older than specified days"""
        cutoff_date = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        cutoff_date = cutoff_date.replace(day=cutoff_date.day - days_to_keep)

        try:
            async with aiosqlite.connect(self.db_path) as db:
                cursor = await db.execute(
                    "DELETE FROM messages WHERE timestamp < ?", (cutoff_date.isoformat(),)
                )
                await db.commit()
                return cursor.rowcount
        except Exception as e:
            log_error(f"Error cleaning up old messages: {e}")
            return 0

    async def get_session_messages(self, session_id: str) -> List[Message]:
        """Get all messages for a specific session"""
        try:
            async with aiosqlite.connect(self.db_path) as db:
                db.row_factory = aiosqlite.Row
                cursor = await db.execute(
                    """
                    SELECT * FROM messages 
                    WHERE session_id = ?
                    ORDER BY timestamp ASC
                """,
                    (session_id,),
                )

                rows = await cursor.fetchall()
                messages = []

                for row in rows:
                    message_data = dict(row)
                    if message_data["metadata"]:
                        message_data["metadata"] = json.loads(message_data["metadata"])
                    messages.append(Message.from_dict(message_data))

                return messages
        except Exception as e:
            log_error(f"Error retrieving session messages: {e}")
            return []

    async def update_message(self, message: Message) -> bool:
        """Update an existing message in the database"""
        try:
            async with aiosqlite.connect(self.db_path) as db:
                await db.execute(
                    """
                    UPDATE messages 
                    SET content = ?, 
                        message_type = ?, 
                        timestamp = ?,
                        session_id = ?,
                        metadata = ?,
                        source_type = ?
                    WHERE id = ?
                """,
                    (
                        message.content,
                        message.message_type.value,
                        message.timestamp.isoformat(),
                        message.session_id,
                        json.dumps(message.metadata) if message.metadata else None,
                        message.source_type,
                        message.id,
                    ),
                )
                await db.commit()
                return True
        except Exception as e:
            log_error(f"Error updating message {message.id}: {e}")
            return False

    async def close(self):
        """Close any open connections and resources"""
        # This is a no-op since we use connection per operation
        # but included for API consistency and future use
        pass
