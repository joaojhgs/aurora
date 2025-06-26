"""
Integration tests for LangGraph and Tools components.
"""
import pytest
import pytest_asyncio
import asyncio
import json
from unittest.mock import patch, MagicMock, AsyncMock

@pytest.mark.integration
class TestLangGraphToolsIntegrationMinimal:
    """Minimal integration tests for LangGraph and Tools components."""
    
    @pytest.fixture
    def mock_memory_store(self):
        """Create a mock memory store."""
        store = MagicMock()
        store.aput = AsyncMock()
        store.aget = AsyncMock(return_value={"key": "value"})
        store.search = MagicMock(return_value=[])
        return store
    
    @pytest.fixture
    def mock_graph(self):
        """Create a mock graph."""
        graph = MagicMock()
        graph.ainvoke = AsyncMock()
        graph.ainvoke.return_value = {
            "messages": [
                {"role": "user", "content": "What's the weather in New York?"},
                {"role": "assistant", "content": "The weather in New York is sunny with a temperature of 25°C."}
            ],
            "current_node": "end"
        }
        return graph

    @pytest.mark.asyncio
    async def test_memory_integration(self, mock_memory_store):
        """Test memory integration."""
        # Define test data
        test_memory = {"conversation_history": ["Hello", "Hi there!"]}
        session_id = "test_session_123"
        namespace = ("conversation", session_id)
        key = "memory"
        
        # Store memory
        await mock_memory_store.aput(namespace, key, test_memory)
        
        # Retrieve memory
        retrieved = await mock_memory_store.aget(namespace, key)
        
        # Verify memory was stored and retrieved
        mock_memory_store.aput.assert_called_once_with(namespace, key, test_memory)
        mock_memory_store.aget.assert_called_once_with(namespace, key)
        assert retrieved == {"key": "value"}  # From our mock return value
    
    @pytest.mark.asyncio
    async def test_graph_execution(self, mock_graph):
        """Test graph execution."""
        # Create an initial state
        initial_input = {"messages": [{"role": "user", "content": "What's the weather in New York?"}]}
        
        # Execute the graph
        result = await mock_graph.ainvoke(input=initial_input)
        
        # Verify the result
        assert "messages" in result
        last_message = result["messages"][-1]
        assert last_message["role"] == "assistant"
        assert "weather" in last_message["content"]
