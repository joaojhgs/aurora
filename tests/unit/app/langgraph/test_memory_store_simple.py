"""
Unit tests for the LangGraph memory store with mock objects.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# Mock SQLiteVecStore class
class MockSQLiteVecStore:
    """Mock implementation of the SQLiteVecStore class."""

    def __init__(self, db_path=":memory:", table="test_memories", embeddings=None):
        self.db_file = db_path
        self.table = table
        self.embeddings = embeddings or MagicMock()
        self.vector_store = None

    def _get_vector_store(self):
        """Get the vector store."""
        if self.vector_store is None:
            self.vector_store = MagicMock()
        return self.vector_store

    async def aput(self, namespace, key, value):
        """Store a value in the vector store."""
        vector_store = self._get_vector_store()
        vector_store.add_texts.return_value = ["doc_id"]
        vector_store.add_texts(["content"], metadatas=[{"key": key}])
        return True

    async def asearch(self, namespace, query, limit=5):
        """Search the vector store."""
        vector_store = self._get_vector_store()
        mock_results = [(f"Result {i}", 0.9 - (i * 0.1)) for i in range(min(limit, 5))]
        vector_store.similarity_search_with_score.return_value = mock_results
        vector_store.similarity_search_with_score(query, k=limit)
        return mock_results


class TestMemoryStore:
    """Tests for the MemoryStore with mock SQLiteVecStore."""

    @pytest.fixture
    def mock_store(self):
        """Create a mock SQLiteVecStore."""
        return MockSQLiteVecStore()

    @pytest.mark.asyncio
    async def test_store_initialization(self, mock_store):
        """Test store initialization."""
        assert mock_store.db_file == ":memory:"
        assert mock_store.table == "test_memories"
        assert mock_store.embeddings is not None

    @pytest.mark.asyncio
    async def test_store_put(self, mock_store):
        """Test storing data."""
        namespace = ("test",)
        key = "test:key"
        value = {"content": "Test memory content", "metadata": {"test": True}}

        # Store the value
        result = await mock_store.aput(namespace, key, value)

        # Verify the result
        assert result is True

        # Verify add_texts was called
        vector_store = mock_store._get_vector_store()
        vector_store.add_texts.assert_called_once()

    @pytest.mark.asyncio
    async def test_store_search(self, mock_store):
        """Test searching for data."""
        namespace = ("test",)
        query = "test query"

        # Search for data
        results = await mock_store.asearch(namespace, query, limit=3)

        # Verify the results
        assert len(results) == 3
        assert results[0][0] == "Result 0"
        assert results[0][1] == 0.9  # Highest similarity score

        # Verify similarity_search_with_score was called
        vector_store = mock_store._get_vector_store()
        vector_store.similarity_search_with_score.assert_called_once()
