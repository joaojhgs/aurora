"""
Unit tests for a simple mock Graph under the orchestrator namespace.
"""

from unittest.mock import MagicMock

import pytest


class MockGraph:
    async def ainvoke(self, input=None, config=None, stream_mode=None):
        """Mock implementation of graph.ainvoke that returns a predefined result."""
        return {
            "messages": [
                {"role": "user", "content": "Test input"},
                {"role": "assistant", "content": "Test response"},
            ]
        }


class TestMockOrchestratorGraph:
    """Tests for the mock orchestrator graph using mock objects."""

    @pytest.mark.asyncio
    async def test_basic_graph_invocation(self):
        """Test basic graph invocation with mocks."""
        mock_graph = MockGraph()

        input_content = "Test input"

        response = await mock_graph.ainvoke(
            input={"messages": [{"role": "user", "content": input_content}]},
            config={"configurable": {"thread_id": "1"}},
            stream_mode="values",
        )

        assert "messages" in response
        assert len(response["messages"]) == 2
        assert response["messages"][0]["role"] == "user"
        assert response["messages"][1]["role"] == "assistant"

    @pytest.mark.asyncio
    async def test_text_to_speech_integration(self):
        """Test integration with text-to-speech."""
        mock_graph = MockGraph()
        mock_tts = MagicMock()

        input_content = "Test input for TTS"

        response = await mock_graph.ainvoke(
            input={"messages": [{"role": "user", "content": input_content}]},
            config={"configurable": {"thread_id": "1"}},
            stream_mode="values",
        )

        text = response["messages"][-1]["content"]
        mock_tts.play(text)

        mock_tts.play.assert_called_once_with("Test response")

    @pytest.mark.asyncio
    async def test_tool_handling(self):
        """Test handling of tool calls."""
        mock_graph = MockGraph()

        async def mock_ainvoke_with_tool(*args, **kwargs):
            return {
                "messages": [
                    {"role": "user", "content": "Use a tool"},
                    {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "tool_123",
                                "type": "function",
                                "function": {
                                    "name": "test_tool",
                                    "arguments": '{"arg1": "value1"}',
                                },
                            }
                        ],
                    },
                ]
            }

        mock_graph.ainvoke = mock_ainvoke_with_tool

        response = await mock_graph.ainvoke(
            input={"messages": [{"role": "user", "content": "Use a tool"}]},
            config={"configurable": {"thread_id": "1"}},
            stream_mode="values",
        )

        assert "messages" in response
        assert len(response["messages"]) == 2
        assert "tool_calls" in response["messages"][1]
        assert response["messages"][1]["tool_calls"][0]["function"]["name"] == "test_tool"
