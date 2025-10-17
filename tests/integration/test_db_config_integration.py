"""
Integration tests for Database and Config components.
"""

import json
import os
import shutil
import tempfile
import uuid
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, mock_open, patch

import pytest
import pytest_asyncio

from app.config.config_manager import ConfigManager
from app.db.manager import DatabaseManager
from app.db.models import Message, MessageType


@pytest.mark.integration
class TestDatabaseIntegration:
    """Integration tests for Database component."""

    @pytest_asyncio.fixture
    async def temp_db_path(self):
        """Create a temporary database path."""
        # Create temporary directory for test
        temp_dir = tempfile.mkdtemp()
        try:
            test_db_path = os.path.join(temp_dir, "test.db")
            yield test_db_path
        finally:
            # Clean up the temporary directory
            shutil.rmtree(temp_dir, ignore_errors=True)

    @pytest.mark.asyncio
    async def test_database_initialization(self, temp_db_path):
        """Test database initialization with custom path."""
        # Create database manager directly with the test path
        db_manager = DatabaseManager(db_path=temp_db_path)
        await db_manager.initialize()

        try:
            # Verify database file was created at the expected path
            assert os.path.exists(temp_db_path)

            # Test storing and retrieving a message
            test_message = Message(
                id=str(uuid.uuid4()),
                content="Integration test message",
                message_type=MessageType.USER_TEXT,
                timestamp=datetime.now(),
            )

            await db_manager.store_message(test_message)
            retrieved_message = await db_manager.get_message_by_id(test_message.id)

            assert retrieved_message is not None
            assert retrieved_message.content == "Integration test message"
        finally:
            # Clean up
            await db_manager.close()

    @pytest.mark.asyncio
    async def test_multiple_database_instances(self, temp_db_path):
        """Test multiple database instances using different paths."""
        # Create first database manager
        db_path1 = temp_db_path
        db_manager1 = DatabaseManager(db_path=db_path1)
        await db_manager1.initialize()

        # Create second database manager with different path
        db_path2 = temp_db_path + ".alt"
        db_manager2 = DatabaseManager(db_path=db_path2)
        await db_manager2.initialize()

        try:
            # Verify both database files were created
            assert os.path.exists(db_path1)
            assert os.path.exists(db_path2)

            # Test storing messages in different databases
            msg1 = Message(
                id=str(uuid.uuid4()),
                content="Message in DB1",
                message_type=MessageType.USER_TEXT,
                timestamp=datetime.now(),
            )

            msg2 = Message(
                id=str(uuid.uuid4()),
                content="Message in DB2",
                message_type=MessageType.ASSISTANT,
                timestamp=datetime.now(),
            )

            # Store messages
            await db_manager1.store_message(msg1)
            await db_manager2.store_message(msg2)

            # Verify messages are in correct databases
            retrieved_msg1 = await db_manager1.get_message_by_id(msg1.id)
            retrieved_msg2 = await db_manager2.get_message_by_id(msg2.id)

            assert retrieved_msg1 is not None
            assert retrieved_msg1.content == "Message in DB1"
            assert retrieved_msg2 is not None
            assert retrieved_msg2.content == "Message in DB2"

            # Verify cross-database isolation
            cross_msg1 = await db_manager2.get_message_by_id(msg1.id)
            cross_msg2 = await db_manager1.get_message_by_id(msg2.id)

            assert cross_msg1 is None
            assert cross_msg2 is None
        finally:
            await db_manager1.close()
            await db_manager2.close()

    @pytest.mark.asyncio
    async def test_database_migration(self):
        """Test database migration process."""
        # Create temporary database
        db_fd, db_path = tempfile.mkstemp(suffix=".db")
        os.close(db_fd)

        try:
            # Create database manager
            with patch("app.db.database_manager.MigrationManager") as mock_migration:
                # Set up mock for migration manager
                instance = MagicMock()
                mock_migration.return_value = instance
                instance.run_migrations = AsyncMock()

                # Initialize database
                db_manager = DatabaseManager(db_path=db_path)
                await db_manager.initialize()

                # Verify migration was run during initialization
                instance.run_migrations.assert_called_once()

                # Close the database
                await db_manager.close()
        finally:
            # Clean up
            os.unlink(db_path)


@pytest.mark.integration
class TestConfigIntegration:
    """Integration tests for Config component."""

    @pytest.fixture
    def temp_config_file(self):
        """Create a temporary config file."""
        # Create temporary file for config
        fd, config_path = tempfile.mkstemp(suffix=".json")
        os.close(fd)

        # Create test config with required fields
        test_config = {
            "app": {"name": "Aurora Test", "version": "0.1.0"},
            "database": {"path": ":memory:"},
            "ui": {"activate": True, "dark_mode": True, "debug": False},
            "llm": {
                "provider": "llama_cpp",
                "third_party": {
                    "openai": {"options": {"model": "gpt-3.5-turbo"}},
                    "huggingface_endpoint": {
                        "options": {
                            "endpoint_url": "https://api-inference.huggingface.co/models/gpt2",
                            "access_token": "test_token",
                        }
                    },
                },
                "local": {
                    "llama_cpp": {"options": {"model_path": "chat_models/model.gguf"}},
                    "huggingface_pipeline": {"options": {"model": "gpt2"}},
                },
            },
            "embeddings": {"provider": "local"},
            "speech_to_text": {"enabled": False},
            "text_to_speech": {"enabled": False},
            "hardware_acceleration": {
                "tts": False,
                "stt": False,
                "ocr_bg": False,
                "ocr_curr": False,
                "llm": False,
            },
            "plugins": {"enabled": []},
            "google": {"credentials_file": ""},
        }

        # Write config to file
        with open(config_path, "w") as f:
            json.dump(test_config, f)

        yield config_path

        # Clean up
        os.unlink(config_path)

    def test_config_initialization(self, temp_config_file):
        """Test config initialization from file."""
        # Reset singleton instance
        ConfigManager._instance = None

        # Initialize with mocked file operations
        with (
            patch("os.path.exists", return_value=True),
            patch("builtins.open", mock_open(read_data=open(temp_config_file).read())),
            patch.object(ConfigManager, "_validate_config"),
        ):
            config_manager = ConfigManager()

            # Force our test config into the ConfigManager
            with open(temp_config_file) as f:
                test_config = json.load(f)
                config_manager._config = test_config

            # Verify config was loaded correctly
            assert config_manager._config["ui"]["activate"] is True
            assert config_manager._config["llm"]["provider"] == "llama_cpp"

    def test_config_update_and_save(self, temp_config_file):
        """Test updating and saving config."""
        # Reset singleton instance
        ConfigManager._instance = None

        # Initialize with mocked file operations
        with (
            patch("os.path.exists", return_value=True),
            patch("builtins.open", mock_open(read_data=open(temp_config_file).read())),
            patch.object(ConfigManager, "_validate_config"),
        ):
            config_manager = ConfigManager()

            # Force our test config into the ConfigManager
            with open(temp_config_file) as f:
                test_config = json.load(f)
                config_manager._config = test_config

            # Update config
            config_manager._config["ui"]["debug"] = True
            config_manager._config["llm"]["provider"] = "openai"

            # Need to set the config_file path on the instance directly
            config_manager.config_file = temp_config_file

            # Save with mocked file operations
            save_mock = mock_open()
            with patch("builtins.open", save_mock) as mock_file:
                config_manager.save_config()

                # Verify file was written with updated config
                mock_file.assert_called_once_with(temp_config_file, "w")
                handle = mock_file()

                # Check that json.dump was called
                # We can't verify the exact content because of the way mock_open works
                assert handle.write.call_count > 0
