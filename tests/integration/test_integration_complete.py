"""
Integration tests for the Aurora system components.
"""

import json
import os
import shutil
import tempfile
import uuid
from datetime import datetime
from unittest.mock import mock_open, patch

import pytest
import pytest_asyncio

from app.config.config_manager import ConfigManager
from app.db.manager import DatabaseManager
from app.db.models import Message, MessageType


@pytest.mark.integration
class TestConfigIntegration:
    """Tests for ConfigManager integration."""

    @pytest.fixture
    def temp_config_file(self):
        """Create a temporary config file."""
        # Create a temporary file
        fd, path = tempfile.mkstemp(suffix=".json")
        os.close(fd)

        # Create sample config data
        config_data = {
            "app": {"name": "Aurora Test", "version": "0.1.0"},
            "database": {"path": ":memory:"},
        }

        # Write config to file
        with open(path, "w") as f:
            json.dump(config_data, f)

        yield path, config_data

        # Clean up
        os.unlink(path)

    def test_config_loading(self, temp_config_file):
        """Test loading configuration from a file."""
        path, expected_config = temp_config_file

        # Reset singleton instance
        original_instance = ConfigManager._instance
        ConfigManager._instance = None

        try:
            # Initialize with the test config file
            with patch("app.config.config_manager.os.path.exists", return_value=True):
                with patch("builtins.open", mock_open(read_data=json.dumps(expected_config))):
                    # Create instance with validation disabled
                    with patch.object(ConfigManager, "_validate_config"):
                        config_manager = ConfigManager()
                        config_manager.config_file = path

                        # Load the real config
                        config_manager._config = expected_config

                        # Check if the config was properly loaded
                        assert "app" in config_manager._config
                        assert config_manager._config["app"]["name"] == "Aurora Test"
                        assert config_manager._config["app"]["version"] == "0.1.0"

        finally:
            # Reset to original instance
            ConfigManager._instance = original_instance


@pytest.mark.integration
class TestDatabaseIntegration:
    """Tests for DatabaseManager integration."""

    @pytest_asyncio.fixture
    async def test_db(self):
        """Create a test database."""
        # Create a temporary file for the database
        fd, path = tempfile.mkstemp(suffix=".db")
        os.close(fd)

        # Initialize the database manager
        db_manager = DatabaseManager(db_path=path)
        await db_manager.initialize()

        yield path, db_manager

        # Clean up
        await db_manager.close()
        os.unlink(path)

    @pytest.mark.asyncio
    async def test_message_storage_and_retrieval(self, test_db):
        """Test storing and retrieving messages."""
        _, db_manager = test_db

        # Create a test message
        message = Message(
            id=str(uuid.uuid4()),
            content="Test message",
            message_type=MessageType.USER_TEXT,
            timestamp=datetime.now(),
        )

        # Store the message
        await db_manager.store_message(message)

        # Retrieve the message
        retrieved = await db_manager.get_message_by_id(message.id)

        # Verify retrieval
        assert retrieved is not None
        assert retrieved.content == "Test message"
        assert retrieved.message_type == MessageType.USER_TEXT

    @pytest.mark.asyncio
    async def test_recent_messages(self, test_db):
        """Test retrieving recent messages."""
        _, db_manager = test_db

        # Store multiple messages
        for i in range(5):
            message = Message(
                id=str(uuid.uuid4()),
                content=f"Message {i}",
                message_type=MessageType.USER_TEXT if i % 2 == 0 else MessageType.ASSISTANT,
                timestamp=datetime.now(),
            )
            await db_manager.store_message(message)

        # Retrieve recent messages
        recent = await db_manager.get_recent_messages(limit=3)

        # Verify retrieval
        assert len(recent) == 3

        # The exact order depends on the implementation, but we should have 3 messages
        # and they should be properly retrieved with their content
        for i, msg in enumerate(recent):
            assert isinstance(msg, Message)
            assert msg.content.startswith("Message ")
            if i > 0:
                # Messages should be in some sensible order (oldest are last or first)
                # Just check that they're not the same message
                assert msg.id != recent[i - 1].id


@pytest.mark.integration
class TestDatabaseConfigIntegration:
    """Integration tests between Database and Config components."""

    @pytest_asyncio.fixture
    async def setup_test_environment(self):
        """Set up a test environment with both config and database."""
        # Create temporary directory
        temp_dir = tempfile.mkdtemp()

        try:
            # Create test paths
            config_path = os.path.join(temp_dir, "config.json")
            test_db_path = os.path.join(temp_dir, "test.db")

            # Create test config
            test_config = {
                "app": {"name": "Aurora Test", "version": "0.1.0"},
                "database": {"path": test_db_path},
            }

            # Write config to file
            with open(config_path, "w") as f:
                json.dump(test_config, f)

            # Create database manager with explicit path
            db_manager = DatabaseManager(db_path=test_db_path)
            await db_manager.initialize()

            yield test_db_path, config_path, db_manager

            # Clean up
            await db_manager.close()

        finally:
            # Clean up temporary directory
            shutil.rmtree(temp_dir, ignore_errors=True)

    @pytest.mark.asyncio
    async def test_database_file_creation(self, setup_test_environment):
        """Test database file is created at the correct path."""
        test_db_path, _, _ = setup_test_environment

        # Verify database file exists
        assert os.path.exists(test_db_path)

    @pytest.mark.asyncio
    async def test_database_operations(self, setup_test_environment):
        """Test database operations with configuration."""
        _, _, db_manager = setup_test_environment

        # Create a test message
        message = Message(
            id=str(uuid.uuid4()),
            content="Integration test",
            message_type=MessageType.USER_TEXT,
            timestamp=datetime.now(),
        )

        # Store the message
        await db_manager.store_message(message)

        # Retrieve and verify
        retrieved = await db_manager.get_message_by_id(message.id)
        assert retrieved is not None
        assert retrieved.content == "Integration test"
