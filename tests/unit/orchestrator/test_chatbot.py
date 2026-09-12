"""Unit tests for chatbot agent."""

import asyncio
import contextlib
import sys
import threading
import time
from unittest.mock import AsyncMock, MagicMock, Mock, patch

import pytest

from app.messaging import MessageBus, QueryResult
from app.services.orchestrator.agents.chatbot import _protocol_safe_prompt_suffix, chatbot
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


class TestProtocolSafePromptSuffix:
    """Keep recent prompts within the chat-provider tool message protocol."""

    def test_keeps_the_configured_recent_window_without_tool_results(self):
        """Ordinary conversation history remains capped at the requested window."""
        from langchain_core.messages import AIMessage, HumanMessage

        messages = [
            HumanMessage(content="oldest"),
            AIMessage(content="older"),
            HumanMessage(content="recent"),
            AIMessage(content="newer"),
            HumanMessage(content="newest"),
        ]

        assert _protocol_safe_prompt_suffix(messages, recent_window=4) == messages[-4:]

    def test_expands_to_include_the_ai_message_owning_leading_tool_results(self):
        """A large tool transaction never starts the provider prompt with orphan results."""
        from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

        tool_calls = [
            {
                "name": "lookup_schedule",
                "args": {"index": index},
                "id": f"call-{index}",
                "type": "tool_call",
            }
            for index in range(5)
        ]
        owner = AIMessage(content="", tool_calls=tool_calls)
        results = [
            ToolMessage(content=f"result-{index}", tool_call_id=f"call-{index}")
            for index in range(5)
        ]
        messages = [HumanMessage(content="list every schedule"), owner, *results]

        suffix = _protocol_safe_prompt_suffix(messages, recent_window=4)

        assert suffix == [owner, *results]
        assert isinstance(suffix[0], AIMessage)
        assert [message.tool_call_id for message in suffix[1:]] == [
            f"call-{index}" for index in range(5)
        ]


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
    async def test_chatbot_sync_invoke_fallback_does_not_block_event_loop(
        self, mock_bus, mock_state
    ):
        """Sync-only LLM adapters are invoked from a worker thread."""

        from langchain_core.messages import AIMessage

        import app.services.orchestrator.agents.chatbot as chatbot_module

        class SyncOnlyLLM:
            invoke_thread_id: int | None = None

            def bind_tools(self, tools, tool_choice=None):
                return self

            def astream(self, messages):
                async def _stream():
                    raise NotImplementedError
                    yield

                return _stream()

            def invoke(self, messages):
                self.invoke_thread_id = threading.get_ident()
                time.sleep(0.2)
                return AIMessage(content="Response")

        sync_llm = SyncOnlyLLM()
        mock_bus.request.side_effect = [
            QueryResult(ok=True, data={"items": []}),
            QueryResult(ok=True, data={"tools": []}),
        ]
        tick_delay = None

        async def _tick():
            nonlocal tick_delay
            started_at = time.perf_counter()
            await asyncio.sleep(0.05)
            tick_delay = time.perf_counter() - started_at

        event_loop_thread_id = threading.get_ident()
        with (
            patch.object(chatbot_module, "_initialize_llm", new_callable=AsyncMock),
            patch.object(chatbot_module, "llm", sync_llm),
            patch.object(chatbot_module, "_llm_initialized", True),
        ):
            result, _ = await asyncio.gather(chatbot(mock_state, bus=mock_bus), _tick())

        assert result["messages"][0].content == "Response"
        assert sync_llm.invoke_thread_id is not None
        assert sync_llm.invoke_thread_id != event_loop_thread_id
        assert tick_delay is not None
        assert tick_delay < 0.15

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
                    ],
                    "blocked_tools": [
                        {
                            "reason_code": "confirmation_required",
                            "reason": "tool requires approval before it can be model-bound",
                            "tool": {
                                "name": "delete_file",
                                "local_name": "delete_file",
                                "global_tool_id": "local:Tooling:tool:delete_file",
                                "provider_peer_id": "local",
                                "provider_service_instance_id": "local:Tooling",
                                "display_name": "delete_file",
                                "description": "Delete a file.",
                                "args_schema": {"properties": {}, "required": []},
                                "execution_location": "local",
                                "source_type": "local",
                                "safety_class": "dangerous",
                                "confirmation_required": True,
                            },
                        }
                    ],
                },
            ),  # Tool retrieval
        ]

        with _patch_llm_for_chatbot():
            result = await chatbot(mock_state, bus=mock_bus)

            # Verify tools were requested via bus
            assert mock_bus.request.call_count >= 2
            catalog_call = mock_bus.request.call_args_list[1]
            assert catalog_call[0][0] == ToolingMethods.GET_TOOL_CATALOG
            catalog_payload = catalog_call[0][1]
            assert catalog_payload.query == mock_state["messages"][-1].content
            assert catalog_payload.top_k == 10
            assert catalog_payload.caller_permissions == ["*"]

            # LLM was called to produce a response
            assert "messages" in result
            assert result["approval_candidates"]["delete_file"]["approval_required"] is True

    @pytest.mark.asyncio
    async def test_chatbot_fails_closed_when_catalog_unavailable(self, mock_bus, mock_state):
        """Chatbot binds no tools when the policy-aware catalog is unavailable."""
        from app.messaging import QueryResult
        from app.shared.contracts.models.tooling import ToolingMethods

        mock_bus.request.side_effect = [
            QueryResult(ok=True, data={"items": []}),
            QueryResult(ok=False, error="unknown method"),
        ]

        with _patch_llm_for_chatbot():
            result = await chatbot(mock_state, bus=mock_bus)

        assert "messages" in result
        assert mock_bus.request.call_args_list[1][0][0] == ToolingMethods.GET_TOOL_CATALOG
        assert len(mock_bus.request.call_args_list) == 2

    @pytest.mark.asyncio
    async def test_chatbot_binds_search_tool_for_search_tool_request(self, mock_bus):
        """A search-tool user request gets the catalog's DDG search tool bound to the LLM."""
        from langchain_core.messages import HumanMessage

        from app.messaging import QueryResult
        from app.services.orchestrator.state import State
        from app.shared.contracts.models.tooling import ToolingMethods

        state = State(messages=[HumanMessage(content="use the search tool")])
        mock_bus.request.side_effect = [
            QueryResult(ok=True, data={"items": []}),
            QueryResult(
                ok=True,
                data={
                    "tools": [
                        {
                            "name": "duckduckgo_results_json",
                            "local_name": "duckduckgo_results_json",
                            "global_tool_id": "local:local_Tooling:tool:duckduckgo_results_json",
                            "provider_peer_id": "local",
                            "provider_service_instance_id": "local:Tooling",
                            "display_name": "duckduckgo_results_json",
                            "description": "Duck Duck Go search for current events.",
                            "args_schema": {
                                "type": "object",
                                "properties": {"query": {"type": "string"}},
                                "required": ["query"],
                            },
                            "execution_location": "local",
                            "source_type": "local",
                            "safety_class": "standard",
                            "confirmation_required": False,
                        }
                    ],
                    "blocked_tools": [],
                },
            ),
        ]

        with _patch_llm_for_chatbot():
            import app.services.orchestrator.agents.chatbot as chatbot_module

            result = await chatbot(state, bus=mock_bus)

            assert "messages" in result
            assert mock_bus.request.call_args_list[1][0][0] == ToolingMethods.GET_TOOL_CATALOG
            catalog_request = mock_bus.request.call_args_list[1][0][1]
            assert catalog_request.query == "use the search tool"
            bound_tools = chatbot_module.llm.bind_tools.call_args[0][0]
            assert [tool.name for tool in bound_tools] == ["duckduckgo_results_json"]

    @pytest.mark.asyncio
    async def test_chatbot_get_tools_failure(self, mock_bus, mock_state):
        """Test tool retrieval failure via bus."""
        from app.messaging import QueryResult

        # Mock memory search success, tool retrieval failure
        mock_bus.request.side_effect = [
            QueryResult(ok=True, data={"items": []}),  # Memory search
            QueryResult(ok=False, error="Tool catalog failed"),  # Catalog retrieval
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
        import app.services.orchestrator.agents.chatbot as chatbot_module

        with (
            patch.object(chatbot_module, "_initialize_llm", new_callable=AsyncMock),
            patch.object(chatbot_module, "_llm_initialized", False),
            patch.object(chatbot_module, "llm", None),
            contextlib.suppress(ValueError, ModuleNotFoundError),
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
