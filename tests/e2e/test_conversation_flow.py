"""
End-to-end test for a basic conversation workflow.
"""

from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio

from app.database.models import Message, MessageType


@pytest.mark.e2e
class TestBasicConversationFlow:
    """Test a basic conversation flow in Aurora."""

    @pytest_asyncio.fixture
    async def mock_environment(self):
        """Set up a mock environment for testing."""
        # Mock database
        mock_db = MagicMock()
        mock_db.store_message = AsyncMock(return_value=True)
        mock_db.get_recent_messages = AsyncMock(return_value=[])

        # Mock config
        mock_config = MagicMock()
        mock_config.get = MagicMock(
            return_value={
                "text_to_speech": {"enabled": False},
                "speech_to_text": {"enabled": False},
                "langgraph": {"enabled": True},
            }
        )

        # Mock graph
        mock_graph = MagicMock()
        mock_graph.ainvoke = AsyncMock(
            return_value={
                "messages": [
                    {"role": "user", "content": "Hello, Aurora."},
                    {"role": "assistant", "content": "Hello! How can I help you today?"},
                ]
            }
        )

        yield {"database": mock_db, "config": mock_config, "graph": mock_graph}

    @pytest.mark.asyncio
    async def test_basic_conversation(self, mock_environment):
        """Test a basic conversation flow."""
        # Patch key components
        with patch(
            "app.database.database_manager.DatabaseManager",
            return_value=mock_environment["database"],
        ):
            with patch(
                "app.config.config_manager.ConfigManager.get_instance",
                return_value=mock_environment["config"],
            ):
                with patch("app.langgraph.graph.graph", mock_environment["graph"]):
                    # Import after patching
                    from app.langgraph.graph import process_text_input

                    # Simulate user input
                    response = await process_text_input("Hello, Aurora.")

                    # Verify the response
                    assert response == "Hello! How can I help you today?"

                    # Verify the graph was called
                    mock_environment["graph"].ainvoke.assert_called_once()

    @pytest.mark.asyncio
    async def test_conversation_with_database(self, mock_environment):
        """Test that conversation messages are stored in the database."""
        # Patch key components
        with patch(
            "app.database.database_manager.DatabaseManager",
            return_value=mock_environment["database"],
        ):
            with patch(
                "app.config.config_manager.ConfigManager.get_instance",
                return_value=mock_environment["config"],
            ):
                with patch("app.langgraph.graph.graph", mock_environment["graph"]):
                    # Import after patching
                    from app.database.message_history_service import store_message
                    from app.langgraph.graph import process_text_input

                    # Process the message
                    user_input = "Hello, Aurora."
                    response = await process_text_input(user_input)

                    # Store the user message
                    user_message = Message(
                        content=user_input,
                        message_type=MessageType.USER_TEXT,
                        timestamp=datetime.now(),
                    )
                    await store_message(user_message)

                    # Store the assistant message
                    assistant_message = Message(
                        content=response,
                        message_type=MessageType.ASSISTANT,
                        timestamp=datetime.now(),
                    )
                    await store_message(assistant_message)

                    # Verify messages were stored
                    calls = mock_environment["database"].store_message.call_args_list
                    assert len(calls) == 2
                    assert calls[0][0][0].content == user_input
                    assert calls[0][0][0].message_type == MessageType.USER_TEXT
                    assert calls[1][0][0].content == response
                    assert calls[1][0][0].message_type == MessageType.ASSISTANT
