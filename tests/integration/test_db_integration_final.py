"""
Integration tests for Database and Config components.
"""
import os
import json
import pytest
import pytest_asyncio
import uuid
import tempfile
import shutil
from datetime import datetime
from pathlib import Path
from unittest.mock import patch, MagicMock, AsyncMock, mock_open

from app.config.config_manager import ConfigManager
from app.database.database_manager import DatabaseManager
from app.database.models import Message, MessageType


@pytest.mark.integration
class TestDatabaseConfigIntegration:
    """Integration tests for Database and Config components."""
    
    @pytest_asyncio.fixture
    async def test_environment(self):
        """Create a test environment with config and database."""
        # Create temporary directory for test
        temp_dir = tempfile.mkdtemp()
        try:
            # Create test paths
            config_path = os.path.join(temp_dir, "config.json")
            test_db_path = os.path.join(temp_dir, "test.db")
            
            # Create test config
            test_config = {
                "app": {
                    "name": "Aurora Test",
                    "version": "0.1.0",
                    "log_level": "DEBUG"
                },
                "database": {
                    "path": test_db_path
                },
                "speech_to_text": {
                    "enabled": False
                },
                "text_to_speech": {
                    "enabled": False
                },
                "scheduler": {
                    "enabled": False
                }
            }
            
            # Write config to file
            with open(config_path, "w") as f:
                json.dump(test_config, f)
            
            # Create database manager with the test path
            db_manager = DatabaseManager(db_path=test_db_path)
            await db_manager.initialize()
            
            yield test_db_path, test_config, db_manager
            
            # Clean up
            await db_manager.close()
            
        finally:
            # Clean up temporary directory
            shutil.rmtree(temp_dir, ignore_errors=True)
    
    @pytest.mark.asyncio
    async def test_database_operations(self, test_environment):
        """Test database operations."""
        test_db_path, _, db_manager = test_environment
        
        # Verify database file was created
        assert os.path.exists(test_db_path)
        
        # Create a test message
        test_message = Message(
            id=str(uuid.uuid4()),
            content="Integration test message",
            message_type=MessageType.USER_TEXT,
            timestamp=datetime.now()
        )
        
        # Store the message
        await db_manager.store_message(test_message)
        
        # Retrieve the message
        retrieved_message = await db_manager.get_message_by_id(test_message.id)
        
        # Verify the message was stored and retrieved correctly
        assert retrieved_message is not None
        assert retrieved_message.content == "Integration test message"
        assert retrieved_message.message_type == MessageType.USER_TEXT
    
    @pytest.mark.asyncio
    async def test_database_update(self, test_environment):
        """Test updating messages in the database."""
        _, _, db_manager = test_environment
        
        # Create and store a message
        original_message = Message(
            id=str(uuid.uuid4()),
            content="Original message",
            message_type=MessageType.USER_TEXT,
            timestamp=datetime.now()
        )
        await db_manager.store_message(original_message)
        
        # Update the message
        updated_message = Message(
            id=original_message.id,
            content="Updated message",
            message_type=MessageType.USER_TEXT,
            timestamp=original_message.timestamp
        )
        
        # Perform the update
        success = await db_manager.update_message(updated_message)
        assert success is True
        
        # Retrieve the updated message
        retrieved_message = await db_manager.get_message_by_id(original_message.id)
        
        # Verify the message was updated correctly
        assert retrieved_message is not None
        assert retrieved_message.content == "Updated message"
    
    @pytest.mark.asyncio
    async def test_multiple_database_instances(self, test_environment):
        """Test multiple database instances can work with the same file."""
        test_db_path, _, _ = test_environment
        
        # Create additional database manager instances pointing to the same file
        db_manager1 = DatabaseManager(db_path=test_db_path)
        await db_manager1.initialize()
        
        db_manager2 = DatabaseManager(db_path=test_db_path)
        await db_manager2.initialize()
        
        try:
            # Store a message using the first manager
            message1 = Message(
                id=str(uuid.uuid4()),
                content="Message from manager 1",
                message_type=MessageType.USER_TEXT,
                timestamp=datetime.now()
            )
            await db_manager1.store_message(message1)
            
            # Store a message using the second manager
            message2 = Message(
                id=str(uuid.uuid4()),
                content="Message from manager 2",
                message_type=MessageType.ASSISTANT,
                timestamp=datetime.now()
            )
            await db_manager2.store_message(message2)
            
            # Retrieve messages using the opposite managers to verify shared access
            retrieved1 = await db_manager2.get_message_by_id(message1.id)
            retrieved2 = await db_manager1.get_message_by_id(message2.id)
            
            # Verify both messages were stored and can be retrieved by either manager
            assert retrieved1 is not None
            assert retrieved1.content == "Message from manager 1"
            
            assert retrieved2 is not None
            assert retrieved2.content == "Message from manager 2"
        finally:
            # Clean up
            await db_manager1.close()
            await db_manager2.close()
