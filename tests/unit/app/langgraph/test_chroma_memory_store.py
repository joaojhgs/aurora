"""
Unit tests for the simplified Chroma-only memory store.
"""

import pytest
import tempfile
import shutil
from unittest.mock import MagicMock, patch
from pathlib import Path

from app.langgraph.memory_store import (
    ChromaVectorStore,
    ChromaMemoryStoreAdapter,
    get_combined_store
)


class TestChromaVectorStore:
    """Tests for the ChromaVectorStore singleton class."""

    @pytest.fixture
    def mock_embeddings(self):
        """Create mock embeddings for testing."""
        embeddings = MagicMock()
        embeddings.embed_documents = MagicMock(return_value=[[0.1, 0.2, 0.3]])
        embeddings.embed_query = MagicMock(return_value=[0.1, 0.2, 0.3])
        return embeddings

    def test_singleton_behavior(self):
        """Test that ChromaVectorStore is a singleton."""
        store1 = ChromaVectorStore()
        store2 = ChromaVectorStore()
        assert store1 is store2

    @patch('app.langgraph.memory_store.get_embeddings')
    @patch('app.langgraph.memory_store.config_manager')
    def test_initialization(self, mock_config, mock_get_embeddings):
        """Test ChromaVectorStore initialization."""
        mock_embeddings = MagicMock()
        mock_get_embeddings.return_value = mock_embeddings
        mock_config.get.return_value = {
            "type": "local",
            "local": {"persist_directory": "./data/chroma"},
            "server": {"host": "localhost", "port": 8000}
        }
        
        store = ChromaVectorStore()
        store.reset()  # Reset for clean test
        store._ensure_initialized()
        
        assert store._embeddings == mock_embeddings
        assert store._chroma_config is not None


class TestChromaMemoryStoreAdapter:
    """Tests for the ChromaMemoryStoreAdapter class."""

    @pytest.fixture
    def mock_chroma_store(self):
        """Create a mock ChromaVectorStore."""
        with patch('app.langgraph.memory_store.ChromaVectorStore') as mock_class:
            mock_instance = MagicMock()
            mock_collection = MagicMock()
            mock_instance.get_collection.return_value = mock_collection
            mock_class.return_value = mock_instance
            yield mock_instance, mock_collection

    def test_collection_routing(self):
        """Test that namespaces are converted directly to collection names."""
        adapter = ChromaMemoryStoreAdapter()
        
        # Test memories namespace
        assert adapter._get_collection_name(("main", "memories")) == "main_memories"
        
        # Test tools namespace
        assert adapter._get_collection_name(("tools",)) == "tools"
        
        # Test other namespace patterns
        assert adapter._get_collection_name(("user", "data")) == "user_data"
        assert adapter._get_collection_name(("system",)) == "system"

    def test_text_content_formatting(self):
        """Test text content formatting for different value types."""
        adapter = ChromaMemoryStoreAdapter()
        
        # Test with text field
        value1 = {"text": "This is a memory"}
        assert adapter._format_text_content(value1) == "This is a memory"
        
        # Test with name and description
        value2 = {"name": "test_tool", "description": "A test tool"}
        assert adapter._format_text_content(value2) == "test_tool: A test tool"
        
        # Test fallback to JSON
        value3 = {"other": "data"}
        result = adapter._format_text_content(value3)
        assert "other" in result and "data" in result

    @pytest.mark.asyncio
    async def test_put_operation(self, mock_chroma_store):
        """Test storing data through the adapter."""
        mock_instance, mock_collection = mock_chroma_store
        
        adapter = ChromaMemoryStoreAdapter()
        adapter.chroma_store = mock_instance
        
        # Mock get to return None (no existing item)
        adapter.get = MagicMock(return_value=None)
        
        namespace = ("main", "memories")
        key = "test_key"
        value = {"text": "Test memory content"}
        
        await adapter.aput(namespace, key, value)
        
        # Verify collection was called
        mock_instance.get_collection.assert_called_with("main_memories")
        mock_collection.add_texts.assert_called_once()

    @pytest.mark.asyncio
    async def test_get_operation(self, mock_chroma_store):
        """Test retrieving data through the adapter."""
        mock_instance, mock_collection = mock_chroma_store
        
        adapter = ChromaMemoryStoreAdapter()
        adapter.chroma_store = mock_instance
        
        # Mock collection get response
        mock_collection.get.return_value = {
            'documents': ['test content'],
            'metadatas': [{
                'namespace': 'main|memories',
                'key': 'test_key',
                'value': '{"text": "Test memory content"}'
            }]
        }
        
        namespace = ("main", "memories")
        key = "test_key"
        
        item = await adapter.aget(namespace, key)
        
        assert item is not None
        assert item.key == key
        assert item.namespace == namespace

    @pytest.mark.asyncio
    async def test_search_operation(self, mock_chroma_store):
        """Test searching data through the adapter."""
        mock_instance, mock_collection = mock_chroma_store
        
        adapter = ChromaMemoryStoreAdapter()
        adapter.chroma_store = mock_instance
        
        # Mock search results
        mock_doc = MagicMock()
        mock_doc.metadata = {
            'namespace': 'main|memories',
            'key': 'test_key',
            'value': '{"text": "Test memory content"}'
        }
        
        mock_collection.similarity_search_with_score.return_value = [
            (mock_doc, 0.9)
        ]
        
        namespace = ("main", "memories")
        query = "test query"
        
        results = await adapter.asearch(namespace, query=query, limit=5)
        
        # Verify search was called
        mock_collection.similarity_search_with_score.assert_called_once()
        

class TestMemoryStoreAPI:
    """Tests for the public API functions."""

    def test_get_combined_store_singleton(self):
        """Test that get_combined_store returns the same instance."""
        store1 = get_combined_store()
        store2 = get_combined_store()
        assert store1 is store2

    def test_api_functions_exist(self):
        """Test that all expected API functions exist."""
        from app.langgraph.memory_store import get_memory_store, get_tools_store, get_combined_store, store
        
        # These should not raise errors
        memory_store = get_memory_store()
        tools_store = get_tools_store()
        combined_store = get_combined_store()
        
        # All should return the same ChromaMemoryStoreAdapter instance
        assert memory_store is tools_store
        assert tools_store is combined_store
        
        # Test lazy store proxy
        assert hasattr(store, 'put')
        assert hasattr(store, 'get')
        assert hasattr(store, 'delete')
        assert hasattr(store, 'search')


class TestBackwardCompatibility:
    """Tests to ensure backward compatibility is maintained."""

    @pytest.mark.asyncio
    async def test_existing_usage_patterns(self):
        """Test that existing code patterns still work."""
        from app.langgraph.memory_store import get_combined_store
        
        store = get_combined_store()
        
        # Test that the expected methods exist and can be called
        assert hasattr(store, 'put')
        assert hasattr(store, 'get')
        assert hasattr(store, 'delete')
        assert hasattr(store, 'retrieve_items')
        assert hasattr(store, 'search')
        
        # Test async methods
        assert hasattr(store, 'aput')
        assert hasattr(store, 'aget')
        assert hasattr(store, 'adelete')
        assert hasattr(store, 'alist')
        assert hasattr(store, 'asearch')

    def test_namespace_compatibility(self):
        """Test that existing namespace patterns are handled correctly."""
        adapter = ChromaMemoryStoreAdapter()
        
        # Test existing namespace patterns used in the codebase
        memories_ns = ("main", "memories")
        tools_ns = ("tools",)
        
        assert adapter._get_collection_name(memories_ns) == "main_memories"
        assert adapter._get_collection_name(tools_ns) == "tools"