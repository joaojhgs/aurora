"""
Unit tests for the simplified Chroma memory store with mock objects.
"""

from unittest.mock import MagicMock, patch

import pytest


class TestMemoryStoreSimplified:
    """Tests for the simplified Chroma memory store with mocks."""

    @pytest.fixture
    def mock_chroma_collection(self):
        """Create a mock Chroma collection."""
        collection = MagicMock()
        collection.add_texts.return_value = ["doc_id"]
        collection.get.return_value = {
            'documents': ['test content'],
            'metadatas': [{'namespace': 'test', 'key': 'test_key', 'value': '{"content": "test"}'}]
        }
        collection.similarity_search_with_score.return_value = [
            (MagicMock(metadata={'namespace': 'test', 'key': 'test_key', 'value': '{"content": "test"}'}), 0.9)
        ]
        collection.similarity_search.return_value = [
            MagicMock(metadata={'namespace': 'test', 'key': 'test_key', 'value': '{"content": "test"}'})
        ]
        return collection

    @pytest.fixture
    def mock_chroma_store(self, mock_chroma_collection):
        """Create a mock ChromaVectorStore."""
        with patch('app.langgraph.memory_store.ChromaVectorStore') as mock_class:
            mock_instance = MagicMock()
            mock_instance.get_collection.return_value = mock_chroma_collection
            mock_class.return_value = mock_instance
            return mock_instance

    @pytest.mark.asyncio
    async def test_store_initialization(self, mock_chroma_store):
        """Test store initialization."""
        from app.langgraph.memory_store import ChromaMemoryStoreAdapter
        
        adapter = ChromaMemoryStoreAdapter()
        adapter.chroma_store = mock_chroma_store
        
        # Test that collections can be accessed
        collection = adapter.chroma_store.get_collection("memories")
        assert collection is not None

    @pytest.mark.asyncio
    async def test_store_put(self, mock_chroma_store, mock_chroma_collection):
        """Test storing data."""
        from app.langgraph.memory_store import ChromaMemoryStoreAdapter
        
        adapter = ChromaMemoryStoreAdapter()
        adapter.chroma_store = mock_chroma_store
        
        # Mock get to return None (no existing item)
        adapter.get = MagicMock(return_value=None)
        
        namespace = ("test", "memories")
        key = "test:key"
        value = {"text": "Test memory content", "metadata": {"test": True}}

        # Store the value
        await adapter.aput(namespace, key, value)

        # Verify the collection was accessed and add_texts was called
        mock_chroma_store.get_collection.assert_called_with("test_memories")
        mock_chroma_collection.add_texts.assert_called_once()

    @pytest.mark.asyncio
    async def test_store_search(self, mock_chroma_store, mock_chroma_collection):
        """Test searching for data."""
        from app.langgraph.memory_store import ChromaMemoryStoreAdapter
        
        adapter = ChromaMemoryStoreAdapter()
        adapter.chroma_store = mock_chroma_store
        
        namespace = ("test", "memories")
        query = "test query"

        # Search for data
        results = await adapter.asearch(namespace, query=query, limit=3)

        # Verify the search was performed
        mock_chroma_store.get_collection.assert_called_with("test_memories")
        mock_chroma_collection.similarity_search_with_score.assert_called_once()

    @pytest.mark.asyncio
    async def test_store_get(self, mock_chroma_store, mock_chroma_collection):
        """Test getting data by key."""
        from app.langgraph.memory_store import ChromaMemoryStoreAdapter
        
        adapter = ChromaMemoryStoreAdapter()
        adapter.chroma_store = mock_chroma_store
        
        namespace = ("test", "memories")
        key = "test_key"

        # Get data
        item = await adapter.aget(namespace, key)

        # Verify the get was performed
        mock_chroma_store.get_collection.assert_called_with("test_memories")
        mock_chroma_collection.get.assert_called_once()

    @pytest.mark.asyncio
    async def test_store_delete(self, mock_chroma_store, mock_chroma_collection):
        """Test deleting data."""
        from app.langgraph.memory_store import ChromaMemoryStoreAdapter
        
        adapter = ChromaMemoryStoreAdapter()
        adapter.chroma_store = mock_chroma_store
        
        namespace = ("test", "memories")
        key = "test_key"

        # Delete data
        await adapter.adelete(namespace, key)

        # Verify the delete was performed
        mock_chroma_store.get_collection.assert_called_with("test_memories")
        mock_chroma_collection.delete.assert_called_once()

    def test_collection_routing(self):
        """Test namespace to collection routing."""
        from app.langgraph.memory_store import ChromaMemoryStoreAdapter
        
        adapter = ChromaMemoryStoreAdapter()
        
        # Test memories routing
        assert adapter._get_collection_name(("main", "memories")) == "main_memories"
        
        # Test tools routing
        assert adapter._get_collection_name(("tools",)) == "tools"
        
        # Test other patterns
        assert adapter._get_collection_name(("user", "data")) == "user_data"

    def test_text_formatting(self):
        """Test text content formatting."""
        from app.langgraph.memory_store import ChromaMemoryStoreAdapter
        
        adapter = ChromaMemoryStoreAdapter()
        
        # Test text field
        value1 = {"text": "Test content"}
        assert adapter._format_text_content(value1) == "Test content"
        
        # Test name and description
        value2 = {"name": "tool", "description": "A tool"}
        assert adapter._format_text_content(value2) == "tool: A tool"
        
        # Test JSON fallback
        value3 = {"other": "data"}
        result = adapter._format_text_content(value3)
        assert "other" in result
