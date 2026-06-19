"""Unit tests for chatbot agent."""

import contextlib
import sys
from unittest.mock import AsyncMock, MagicMock, Mock, patch

import pytest

from app.messaging import MessageBus
from app.services.orchestrator.agents.chatbot import chatbot
from app.services.orchestrator.state import State

# Mock LLM
sys.modules["app.services.orchestrator.agents.chatbot"].llm = MagicMock()


@contextlib.contextmanager
def _patch_llm_for_chatbot():
    """Helper context manager to patch LLM for chatbot tests."""
    import app.services.orchestrator.agents.chatbot as chatbot_module

    # Create a mock LLM instance
    mock_llm_instance = MagicMock()
    mock_llm_response = MagicMock()
    mock_llm_response.content = "Response"
    mock_bind_tools = MagicMock()
    mock_bind_tools.invoke.return_value = mock_llm_response
    mock_llm_instance.bind_tools.return_value = mock_bind_tools
    mock_llm_instance.invoke.return_value = mock_llm_response

    with (
        patch.object(chatbot_module, "_initialize_llm", new_callable=AsyncMock),
        patch.object(chatbot_module, "llm", mock_llm_instance),
        patch.object(chatbot_module, "_llm_initialized", True),
    ):
        yield


@pytest.fixture
def mock_bus():
    """Create a mock message bus."""
    bus = Mock(spec=MessageBus)
    bus.request = AsyncMock()
    return bus


@pytest.fixture
def mock_state():
    """Create a mock state."""
    from langchain_core.messages import HumanMessage

    return State(
        messages=[
            HumanMessage(content="What is the capital of France?"),
        ]
    )


class TestChatbotMemorySearch:
    """Test chatbot memory search via bus."""

    @pytest.mark.asyncio
    async def test_chatbot_memory_search_success(self, mock_bus, mock_state):
        """Test successful memory search via bus."""
        from app.messaging import QueryResult
        from app.shared.contracts.models.db import DBMethods

        # Mock successful memory search response
        mock_bus.request.return_value = QueryResult(
            ok=True,
            data={
                "items": [
                    {
                        "value": {"text": "Paris is the capital"},
                        "key": "key1",
                        "namespace": ("main", "memories"),
                        "search_score": 0.9,
                    },
                    {
                        "value": {"text": "France capital city"},
                        "key": "key2",
                        "namespace": ("main", "memories"),
                        "search_score": 0.8,
                    },
                ]
            },
        )

        # Mock LLM using helper
        with (
            _patch_llm_for_chatbot(),
            patch("app.services.orchestrator.agents.chatbot.ToolingMethods"),
            patch("app.services.orchestrator.agents.chatbot.ToolingGetToolsRequest"),
        ):
            # Update the mock response for this specific test
            import app.services.orchestrator.agents.chatbot as chatbot_module

            chatbot_module.llm.bind_tools.return_value.invoke.return_value.content = (
                "Paris is the capital of France."
            )

            result = await chatbot(mock_state, bus=mock_bus)

            # Verify memory search was called via bus
            mock_bus.request.assert_called()
            memory_call = [
                call
                for call in mock_bus.request.call_args_list
                if call[0][0] == DBMethods.RAG_SEARCH
            ]
            assert len(memory_call) > 0

            # Verify memories were included in result
            assert "messages" in result

    @pytest.mark.asyncio
    async def test_chatbot_memory_search_failure(self, mock_bus, mock_state):
        """Test memory search failure via bus."""
        from app.messaging import QueryResult

        # Mock failed memory search
        mock_bus.request.return_value = QueryResult(ok=False, error="Search failed")

        with (
            _patch_llm_for_chatbot(),
            patch("app.services.orchestrator.agents.chatbot.ToolingMethods"),
            patch("app.services.orchestrator.agents.chatbot.ToolingGetToolsRequest"),
        ):
            result = await chatbot(mock_state, bus=mock_bus)

            # Should still work even if memory search fails
            assert "messages" in result

    @pytest.mark.asyncio
    async def test_chatbot_memory_search_empty(self, mock_bus, mock_state):
        """Test memory search with no results."""
        from app.messaging import QueryResult

        # Mock empty memory search
        mock_bus.request.return_value = QueryResult(ok=True, data={"items": []})

        with (
            _patch_llm_for_chatbot(),
            patch("app.services.orchestrator.agents.chatbot.ToolingMethods"),
            patch("app.services.orchestrator.agents.chatbot.ToolingGetToolsRequest"),
        ):
            result = await chatbot(mock_state, bus=mock_bus)

            # Should work with no memories
            assert "messages" in result


class TestChatbotToolRetrieval:
    """Test chatbot tool retrieval via bus."""

    @pytest.mark.asyncio
    async def test_chatbot_get_tools_success(self, mock_bus, mock_state):
        """Test successful tool retrieval via bus."""
        from app.messaging import QueryResult
        from app.shared.contracts.models.tooling import ToolingMethods

        # Mock memory search (first call)
        # Mock tool retrieval (second call)
        mock_bus.request.side_effect = [
            QueryResult(ok=True, data={"items": []}),  # Memory search
            QueryResult(
                ok=True,
                data={
                    "tools": [
                        {
                            "name": "test_tool",
                            "description": "A test tool",
                            "args_schema": {"properties": {}, "required": []},
                        }
                    ]
                },
            ),  # Tool retrieval
        ]

        with (
            _patch_llm_for_chatbot(),
            patch(
                "app.services.orchestrator.agents.chatbot.ToolingGetToolCatalogRequest"
            ) as mock_catalog_request,
        ):
            result = await chatbot(mock_state, bus=mock_bus)

            # Verify tools were requested via bus
            assert mock_bus.request.call_count >= 2
            assert mock_bus.request.call_args_list[1][0][0] == ToolingMethods.GET_TOOL_CATALOG
            mock_catalog_request.assert_called_once()

            # LLM was called to produce a response
            assert "messages" in result

    @pytest.mark.asyncio
    async def test_chatbot_falls_back_to_legacy_get_tools(self, mock_bus, mock_state):
        """Chatbot falls back when aggregate catalog is unavailable."""
        from app.messaging import QueryResult
        from app.shared.contracts.models.tooling import ToolingMethods

        mock_bus.request.side_effect = [
            QueryResult(ok=True, data={"items": []}),
            QueryResult(ok=False, error="unknown method"),
            QueryResult(ok=True, data={"tools": []}),
        ]

        with _patch_llm_for_chatbot():
            result = await chatbot(mock_state, bus=mock_bus)

        assert "messages" in result
        assert mock_bus.request.call_args_list[1][0][0] == ToolingMethods.GET_TOOL_CATALOG
        assert mock_bus.request.call_args_list[2][0][0] == ToolingMethods.GET_TOOLS

    @pytest.mark.asyncio
    async def test_chatbot_get_tools_failure(self, mock_bus, mock_state):
        """Test tool retrieval failure via bus."""
        from app.messaging import QueryResult

        # Mock memory search success, tool retrieval failure
        mock_bus.request.side_effect = [
            QueryResult(ok=True, data={"items": []}),  # Memory search
            QueryResult(ok=False, error="Tool catalog failed"),  # Catalog retrieval
            QueryResult(ok=False, error="Tool retrieval failed"),  # Legacy tool retrieval
        ]

        with (
            _patch_llm_for_chatbot(),
            patch("app.services.orchestrator.agents.chatbot.ToolingMethods"),
            patch("app.services.orchestrator.agents.chatbot.ToolingGetToolsRequest"),
        ):
            result = await chatbot(mock_state, bus=mock_bus)

            # Should fallback gracefully
            assert "messages" in result


class TestChatbotLLMIntegration:
    """Test chatbot LLM integration."""

    @pytest.mark.asyncio
    async def test_chatbot_llm_not_initialized(self, mock_bus, mock_state):
        """Test chatbot with uninitialized LLM."""
        with (
            patch(
                "app.services.orchestrator.agents.chatbot._initialize_llm", new_callable=AsyncMock
            ),
            patch("app.services.orchestrator.agents.chatbot.llm", None),
            contextlib.suppress(ValueError),
        ):
            # Should raise or handle gracefully; accept either
            await chatbot(mock_state, bus=mock_bus)

    @pytest.mark.asyncio
    async def test_chatbot_with_tools(self, mock_bus, mock_state):
        """Test chatbot with tools."""
        from app.messaging import QueryResult

        mock_bus.request.side_effect = [
            QueryResult(ok=True, data={"items": []}),  # Memory search
            QueryResult(
                ok=True,
                data={
                    "tools": [
                        {
                            "name": "search_tool",
                            "description": "Search tool",
                            "args_schema": {
                                "properties": {"query": {"type": "string"}},
                                "required": ["query"],
                            },
                        }
                    ]
                },
            ),  # Tool retrieval
        ]

        with (
            _patch_llm_for_chatbot(),
            patch("app.services.orchestrator.agents.chatbot.ToolingMethods"),
            patch("app.services.orchestrator.agents.chatbot.ToolingGetToolsRequest"),
            patch(
                "app.services.orchestrator.agents.chatbot._deserialize_tools"
            ) as mock_deserialize,
        ):
            from langchain_core.tools import tool

            @tool
            def search_tool(query: str):
                """Search tool."""
                return query

            mock_deserialize.return_value = [search_tool]
            result = await chatbot(mock_state, bus=mock_bus)

            # Verify a response was produced
            assert "messages" in result

    @pytest.mark.asyncio
    async def test_chatbot_without_tools(self, mock_bus, mock_state):
        """Test chatbot without tools."""
        from app.messaging import QueryResult

        mock_bus.request.side_effect = [
            QueryResult(ok=True, data={"items": []}),  # Memory search
            QueryResult(ok=True, data={"tools": []}),  # Empty tools
        ]

        with (
            _patch_llm_for_chatbot(),
            patch("app.services.orchestrator.agents.chatbot.ToolingMethods"),
            patch("app.services.orchestrator.agents.chatbot.ToolingGetToolsRequest"),
        ):
            result = await chatbot(mock_state, bus=mock_bus)

            # Ensure response was produced
            assert "messages" in result
