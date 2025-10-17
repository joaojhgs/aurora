"""
Integration tests for Database and Config components.
"""

import os
import shutil
import tempfile
import uuid
from datetime import datetime
from unittest.mock import MagicMock

import pytest
import pytest_asyncio

from app.config.config_manager import ConfigManager
from app.db.manager import DatabaseManager
from app.db.models import Message, MessageType


class TestDBConfigIntegration:
    """Integration tests for Database and Config components."""

    @pytest.fixture
    def test_config_data(self):
        """Create test configuration data."""
        return {
            "app": {"name": "Aurora Test", "version": "0.1.0", "log_level": "DEBUG"},
            "database": {"path": "test_db_path"},  # Will be replaced at runtime
            "speech_to_text": {"enabled": False},
            "text_to_speech": {"enabled": False},
            "scheduler": {"enabled": False},
        }

    @pytest_asyncio.fixture
    async def test_environment(self, test_config_data):
        """Create a test environment with config and database."""
        # Create temporary directory for test
        temp_dir = tempfile.mkdtemp()
        try:
            # Create test paths
            test_db_path = os.path.join(temp_dir, "test.db")

            # Update db path in config
            test_config = test_config_data.copy()
            test_config["database"]["path"] = test_db_path

            # Save original ConfigManager instance
            original_instance = ConfigManager._instance
            ConfigManager._instance = None

            # Create a config manager for testing
            config_manager = MagicMock()
            config_manager._config = test_config
            config_manager.get_config.return_value = test_config
            config_manager.get.side_effect = lambda key: (test_config["database"]["path"] if key == "database.path" else None)

            # Create database manager with the test path
            db_manager = DatabaseManager(db_path=test_db_path)
            await db_manager.initialize()

            yield config_manager, db_manager, test_db_path

            # Clean up
            await db_manager.close()

            # Restore original ConfigManager instance
            ConfigManager._instance = original_instance

        finally:
            # Clean up temporary directory
            shutil.rmtree(temp_dir, ignore_errors=True)

    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_database_operations(self, test_environment):
        """Test basic database operations."""
        _, db_manager, test_db_path = test_environment

        # Verify database file was created
        assert os.path.exists(test_db_path)

        # Test storing and retrieving a message
        test_message = Message(
            id=str(uuid.uuid4()),
            content="Integration test message",
            message_type=MessageType.USER_TEXT,
            timestamp=datetime.now(),
        )

        # Store message
        await db_manager.store_message(test_message)

        # Retrieve message
        retrieved_message = await db_manager.get_message_by_id(test_message.id)

        # Verify message was stored and retrieved correctly
        assert retrieved_message is not None
        assert retrieved_message.content == "Integration test message"
        assert retrieved_message.message_type == MessageType.USER_TEXT

    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_update_message(self, test_environment):
        """Test updating a message in the database."""
        _, db_manager, _ = test_environment

        # Store initial message
        test_message = Message(
            id=str(uuid.uuid4()),
            content="Original content",
            message_type=MessageType.USER_TEXT,
            timestamp=datetime.now(),
        )

        await db_manager.store_message(test_message)

        # Update the message
        updated_message = Message(
            id=test_message.id,
            content="Updated content",
            message_type=MessageType.USER_TEXT,
            timestamp=test_message.timestamp,
        )

        success = await db_manager.update_message(updated_message)
        assert success

        # Retrieve and verify the updated message
        retrieved_message = await db_manager.get_message_by_id(test_message.id)
        assert retrieved_message is not None
        assert retrieved_message.content == "Updated content"
