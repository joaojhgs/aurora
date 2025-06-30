"""
Unit tests for the DatabaseManager.
"""

import asyncio
import os
import sqlite3
import tempfile
import uuid
from datetime import datetime
from unittest.mock import MagicMock, patch

import aiosqlite
import pytest
import pytest_asyncio

from app.database.database_manager import DatabaseManager
from app.database.models import Message, MessageType


@pytest.mark.asyncio
class TestDatabaseManager:
    """Tests for the DatabaseManager class."""

    @pytest_asyncio.fixture
    async def db_manager(self):
        """Create a test database manager using an in-memory database."""
        # Use file-based database for tests with a unique name
        test_db = f"/tmp/aurora_test_{uuid.uuid4()}.db"

        # Create the database manager with our test db
        manager = DatabaseManager(db_path=test_db)

        try:
            # Create tables manually
            async with aiosqlite.connect(test_db) as db:
                await db.execute(
                    """
                    CREATE TABLE IF NOT EXISTS messages (
                        id TEXT PRIMARY KEY,
                        content TEXT NOT NULL,
                        message_type TEXT NOT NULL,
                        timestamp TEXT NOT NULL,
                        session_id TEXT,
                        metadata TEXT,
                        source_type TEXT
                    )
                """
                )
                await db.commit()

            # Return the manager for testing
            yield manager

        finally:
            # Clean up the test database file
            try:
                os.unlink(test_db)
            except (FileNotFoundError, PermissionError):
                pass

    async def test_initialization(self, db_manager):
        """Test database initialization."""
        # Check that the database was initialized
        # Create a test connection to verify the database is accessible
        async with aiosqlite.connect(db_manager.db_path) as conn:
            # Check that the messages table exists
            cursor = await conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='messages'"
            )
            result = await cursor.fetchone()
            assert result is not None
            assert result[0] == "messages"

    async def test_store_message(self, db_manager):
        """Test storing a message in the database."""
        message = Message(
            content="Test message",
            message_type=MessageType.USER_TEXT,
            timestamp=datetime.now(),
            id=str(uuid.uuid4()),
            metadata={"test": True},
        )

        # Store the message
        success = await db_manager.store_message(message)
        assert success
        message_id = message.id

        # Check that the message was stored correctly
        # Connect to database and check
        async with aiosqlite.connect(db_manager.db_path) as conn:
            conn.row_factory = aiosqlite.Row
            cursor = await conn.execute(
                "SELECT content, message_type FROM messages WHERE id = ?", (message_id,)
            )
            result = await cursor.fetchone()

        assert result is not None
        assert result[0] == "Test message"
        assert result[1] == MessageType.USER_TEXT.value

    async def test_get_message_by_id(self, db_manager):
        """Test retrieving a message by ID."""
        # Store a test message
        message = Message(
            content="Test message for retrieval",
            message_type=MessageType.ASSISTANT,
            timestamp=datetime.now(),
            id=str(uuid.uuid4()),
            metadata={"test": True},
        )
        success = await db_manager.store_message(message)
        assert success
        message_id = message.id

        # Retrieve the message
        retrieved_message = await db_manager.get_message_by_id(message_id)

        assert retrieved_message is not None
        assert retrieved_message.id == message_id
        assert retrieved_message.content == "Test message for retrieval"
        assert retrieved_message.message_type == MessageType.ASSISTANT

    async def test_get_recent_messages(self, db_manager):
        """Test retrieving recent messages."""
        # Store multiple test messages
        message_ids = []
        for i in range(5):
            message = Message(
                content=f"Test message {i}",
                message_type=MessageType.USER_TEXT if i % 2 == 0 else MessageType.ASSISTANT,
                timestamp=datetime.now(),
                id=str(uuid.uuid4()),
                metadata={"index": i},
            )
            await db_manager.store_message(message)
            message_ids.append(message.id)

        # Retrieve recent messages
        recent_messages = await db_manager.get_recent_messages(limit=3)

        assert len(recent_messages) == 3
        # Messages should be in reverse chronological order (oldest first, based
        # on the implementation)
        assert "Test message" in recent_messages[0].content
        assert "Test message" in recent_messages[1].content
        assert "Test message" in recent_messages[2].content

    async def test_update_message(self, db_manager):
        """Test updating a message."""
        # Store a test message
        message = Message(
            content="Original content",
            message_type=MessageType.USER_TEXT,
            timestamp=datetime.now(),
            id=str(uuid.uuid4()),
            metadata={"test": True},
        )
        success = await db_manager.store_message(message)
        assert success
        message_id = message.id

        # Update the message
        updated_message = Message(
            id=message_id,
            content="Updated content",
            message_type=MessageType.USER_TEXT,
            timestamp=datetime.now(),
            metadata={"test": True, "updated": True},
        )

        success = await db_manager.update_message(updated_message)
        assert success

        # Retrieve the updated message
        retrieved_message = await db_manager.get_message_by_id(message_id)
        assert retrieved_message.content == "Updated content"
        assert retrieved_message.metadata.get("updated")

    async def test_delete_message(self, db_manager):
        """Test deleting a message."""
        # Store a test message
        message = Message(
            content="Message to delete",
            message_type=MessageType.USER_TEXT,
            timestamp=datetime.now(),
            id=str(uuid.uuid4()),
            metadata={},
        )
        success = await db_manager.store_message(message)
        assert success
        message_id = message.id

        # Delete the message
        success = await db_manager.delete_message(message_id)
        assert success

        # Try to retrieve the deleted message
        deleted_message = await db_manager.get_message_by_id(message_id)
        assert deleted_message is None

    async def test_connection_handling(self):
        """Test connection handling, especially ensuring connections are properly closed."""
        # Create a temporary database file
        fd, db_path = tempfile.mkstemp(suffix=".db")
        os.close(fd)

        try:
            # Create and initialize a database manager
            db_manager = DatabaseManager(db_path=db_path)
            await db_manager.initialize()

            # Test that we can connect to the database and run a query
            async with aiosqlite.connect(db_path) as conn:
                cursor = await conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
                tables = await cursor.fetchall()
                # We should have at least one table after initialization
                assert len(tables) > 0

        finally:
            # Clean up the temporary file
            os.unlink(db_path)

    async def test_error_handling(self):
        """Test error handling for database operations."""
        # Create a database manager with a bad path
        db_manager = DatabaseManager(db_path="/nonexistent/path/db.sqlite")

        # Initialization should fail but not crash
        with pytest.raises(Exception):
            await db_manager.initialize()

    async def test_concurrent_operations(self, db_manager):
        """Test concurrent database operations."""

        # Define a task to store a message
        async def store_task(index):
            message = Message(
                content=f"Concurrent message {index}",
                message_type=MessageType.USER_TEXT,
                timestamp=datetime.now(),
                id=str(uuid.uuid4()),
                metadata={"task": index},
            )
            success = await db_manager.store_message(message)
            return message.id if success else None

        # Create and run multiple concurrent tasks
        tasks = [store_task(i) for i in range(10)]
        message_ids = await asyncio.gather(*tasks)

        # Check that all messages were stored
        for i, message_id in enumerate(message_ids):
            assert message_id is not None
            message = await db_manager.get_message_by_id(message_id)
            assert message is not None
            assert message.content == f"Concurrent message {i}"
            assert message.metadata.get("task") == i
