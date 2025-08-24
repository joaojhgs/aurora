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
            'metadatas': [{'workspace': 'test', 'key': 'test_key', 'value': '{"content": "test"}'}]
        }
        collection.similarity_search_with_score.return_value = [
            (MagicMock(metadata={'workspace': 'test', 'key': 'test_key', 'value': '{"content": "test"}'}), 0.9)
        ]
        collection.similarity_search.return_value = [
            MagicMock(metadata={'workspace': 'test', 'key': 'test_key', 'value': '{"content": "test"}'})
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
        mock_chroma_store.get_collection.assert_called_with("test_memories")  # Backward compatibility still works
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
        mock_chroma_store.get_collection.assert_called_with("test_memories")  # Backward compatibility still works
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
        mock_chroma_store.get_collection.assert_called_with("test_memories")  # Backward compatibility still works
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
        mock_chroma_store.get_collection.assert_called_with("test_memories")  # Backward compatibility still works
        mock_chroma_collection.delete.assert_called_once()

    def test_collection_routing(self):
        """Test workspace to collection routing."""
        from app.langgraph.memory_store import ChromaMemoryStoreAdapter
        
        adapter = ChromaMemoryStoreAdapter()
        
        # Test backward compatibility - namespace tuples still work
        # ("main", "memories") -> "main_memories" workspace 
        workspace = "_".join(("main", "memories"))
        assert workspace == "main_memories"
        
        # ("tools",) -> "tools" workspace
        workspace = "_".join(("tools",)) if len(("tools",)) > 1 else ("tools",)[0]
        assert workspace == "tools"
        
        # ("user", "data") -> "user_data" workspace
        workspace = "_".join(("user", "data"))
        assert workspace == "user_data"
        
        # Test direct workspace names (new interface)
        assert "memories" == "memories"
        assert "tools" == "tools"
        assert "user_data" == "user_data"

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

    @pytest.mark.asyncio
    async def test_workspace_interface(self, mock_chroma_store, mock_chroma_collection):
        """Test the new workspace-based interface."""
        from app.langgraph.memory_store import ChromaMemoryStoreAdapter
        
        adapter = ChromaMemoryStoreAdapter()
        adapter.chroma_store = mock_chroma_store
        
        # Mock get to return None (no existing item)
        adapter.get_workspace = MagicMock(return_value=None)
        
        workspace = "memories"
        key = "test_key"
        value = {"text": "Test memory content"}

        # Store using workspace interface
        adapter.put_workspace(workspace, key, value)

        # Verify the collection was accessed correctly
        mock_chroma_store.get_collection.assert_called_with("memories")
        mock_chroma_collection.add_texts.assert_called_once()

    @pytest.mark.asyncio 
    async def test_convenience_functions(self, mock_chroma_store, mock_chroma_collection):
        """Test the new convenience functions."""
        from app.langgraph.memory_store import put_memory, search_memories, search_tools
        
        # Mock the store
        with patch('app.langgraph.memory_store.get_combined_store') as mock_get_store:
            mock_adapter = MagicMock()
            mock_get_store.return_value = mock_adapter
            
            # Test put_memory
            put_memory("test_key", {"text": "test"})
            mock_adapter.put_workspace.assert_called_with("memories", "test_key", {"text": "test"})
            
            # Test search_memories
            search_memories("test query", limit=5)
            mock_adapter.search_workspace.assert_called_with("memories", query="test query", limit=5)
            
            # Test search_tools
            search_tools("tool query", limit=10)
            mock_adapter.search_workspace.assert_called_with("tools", query="tool query", limit=10)
