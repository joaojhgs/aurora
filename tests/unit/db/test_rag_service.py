"""Unit tests for RAGService."""

import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, Mock, patch

import pytest

from app.services.db.rag_service import (
    CombinedSQLiteVecStore,
    RAGService,
    SQLiteVecStore,
    async_get_embeddings,
    check_and_update_embedding_model,
    get_embedding_model_signature,
)


@pytest.fixture
def temp_db_path():
    """Create a temporary database path."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield Path(tmpdir) / "test_memories.db"


@pytest.fixture
def mock_embeddings():
    """Create mock embeddings."""
    embeddings = MagicMock()
    embeddings.embed_query = Mock(return_value=[0.1] * 384)
    embeddings.embed_documents = Mock(return_value=[[0.1] * 384])
    return embeddings


@pytest.fixture
def rag_service():
    """Create a RAGService instance."""
    return RAGService()


class TestRAGServiceCore:
    """Test RAGService core functionality."""

    def test_rag_service_init(self):
        """Test RAGService initialization."""
        service = RAGService()
        assert service._memories_store is None
        assert service._tools_store is None
        assert service._combined_store is None

    def test_get_embedding_model_signature(self):
        """Test embedding model signature generation."""
        model_info = {"type": "openai", "model_name": "text-embedding-3-small", "version": "openai"}
        signature = get_embedding_model_signature(model_info)
        assert signature == "openai:text-embedding-3-small:openai"

    @patch("app.services.db.rag_service.config_api")
    @pytest.mark.asyncio
    async def test_get_embeddings_local(self, mock_config):
        """Test getting local embeddings."""
        mock_config.aget = AsyncMock(return_value={"embeddings": {"use_local": True}})

        with (
            patch("app.services.db.rag_service._async_wait_for_config_service", return_value=True),
            patch("langchain_huggingface.HuggingFaceEmbeddings") as mock_hf,
        ):
            mock_emb = MagicMock()
            mock_hf.return_value = mock_emb

            embeddings, model_info = await async_get_embeddings()

            assert model_info["type"] == "huggingface"
            assert model_info["model_name"] == "all-MiniLM-L6-v2"
            mock_hf.assert_called_once_with(model_name="all-MiniLM-L6-v2")

    @patch("app.services.db.rag_service.config_api")
    @pytest.mark.asyncio
    async def test_get_embeddings_openai(self, mock_config):
        """Test getting OpenAI embeddings."""
        mock_config.aget = AsyncMock(return_value={"embeddings": {"use_local": False}})

        with (
            patch("app.services.db.rag_service._async_wait_for_config_service", return_value=True),
            patch("langchain.embeddings.init_embeddings") as mock_init,
        ):
            mock_emb = MagicMock()
            mock_init.return_value = mock_emb

            embeddings, model_info = await async_get_embeddings()

            assert model_info["type"] == "openai"
            assert model_info["model_name"] == "text-embedding-3-small"
            mock_init.assert_called_once_with("openai:text-embedding-3-small")


class TestRAGServiceStores:
    """Test RAGService store initialization."""

    @patch("app.services.db.rag_service.async_get_embeddings", new_callable=AsyncMock)
    @patch("app.services.db.rag_service.SQLiteVec")
    @patch("app.services.db.rag_service.Path")
    @pytest.mark.asyncio
    async def test_initialize_stores(self, mock_path, mock_sqlite, mock_get_emb):
        """Test store initialization."""
        # Setup mocks
        mock_path.return_value.parent.mkdir = Mock()
        mock_conn = MagicMock()
        mock_sqlite.create_connection.return_value = mock_conn
        mock_emb = MagicMock()
        mock_get_emb.return_value = (
            mock_emb,
            {"type": "test", "model_name": "test", "version": "test"},
        )

        # Setup connection execution mock
        mock_cursor = MagicMock()
        mock_conn.execute = Mock(return_value=mock_cursor)
        mock_conn.commit = Mock()

        # Mock check_and_update_embedding_model
        with patch(
            "app.services.db.rag_service.check_and_update_embedding_model", return_value=False
        ):
            service = RAGService()
            await service.async_initialize()
            store = service.memories_store

            assert store is not None
            assert service._memories_store is not None

    def test_combined_store_routing(self):
        """Test CombinedSQLiteVecStore namespace routing."""
        mock_memories = MagicMock()
        mock_tools = MagicMock()
        combined = CombinedSQLiteVecStore(mock_memories, mock_tools)

        # Test memories namespace routing
        store = combined._get_store(("main", "memories"))
        assert store is mock_memories

        # Test tools namespace routing
        store = combined._get_store(("tools",))
        assert store is mock_tools

        # Test default routing
        store = combined._get_store(("unknown",))
        assert store is mock_memories  # Defaults to memories

    def test_combined_store_delegation(self):
        """Test CombinedSQLiteVecStore method delegation."""
        mock_memories = MagicMock()
        mock_tools = MagicMock()
        combined = CombinedSQLiteVecStore(mock_memories, mock_tools)

        # Test put delegation
        combined.put(("main", "memories"), "key1", {"text": "test"})
        mock_memories.put.assert_called_once_with(
            ("main", "memories"), "key1", {"text": "test"}, None
        )

        # Test get delegation
        combined.get(("tools",), "tool1")
        mock_tools.get.assert_called_once_with(("tools",), "tool1")

        # Test delete delegation
        combined.delete(("main", "memories"), "key1")
        mock_memories.delete.assert_called_once_with(("main", "memories"), "key1")

        # Test search delegation
        combined.search(("tools",), query="test", limit=5)
        mock_tools.search.assert_called_once_with(("tools",), query="test", limit=5, offset=0)

        # Test retrieve_items delegation
        combined.retrieve_items(("main", "memories"), limit=10, offset=0)
        mock_memories.list_items_in_namespace.assert_called_once_with(
            ("main", "memories"), limit=10, offset=0
        )


class TestSQLiteVecStore:
    """Test SQLiteVecStore implementation."""

    @patch("app.services.db.rag_service.SQLiteVec")
    @patch("app.services.db.rag_service.Path")
    def test_sqlite_vec_store_init(self, mock_path, mock_sqlite):
        """Test SQLiteVecStore initialization."""
        mock_path.return_value.parent.mkdir = Mock()
        mock_conn = MagicMock()
        mock_sqlite.create_connection.return_value = mock_conn

        mock_embeddings = MagicMock()

        store = SQLiteVecStore(db_file="./test.db", table="test", embeddings=mock_embeddings)

        assert store.db_file == "./test.db"
        assert store.table == "test"
        assert store.embeddings is mock_embeddings

    @patch("app.services.db.rag_service.SQLiteVec")
    def test_sqlite_vec_store_put(self, mock_sqlite):
        """Test SQLiteVecStore put operation."""
        mock_conn = MagicMock()
        mock_sqlite.create_connection.return_value = mock_conn

        mock_embeddings = MagicMock()
        store = SQLiteVecStore(db_file=":memory:", table="test", embeddings=mock_embeddings)

        # Vector store mock for add_texts will be created inside store
        store.put(("main", "memories"), "key1", {"text": "Test memory"})

    @patch("app.services.db.rag_service.SQLiteVec")
    def test_sqlite_vec_store_get(self, mock_sqlite):
        """Test SQLiteVecStore get operation."""
        mock_conn = MagicMock()
        mock_sqlite.create_connection.return_value = mock_conn

        # Mock document with metadata
        from unittest.mock import Mock as MockDoc

        mock_doc = MockDoc()
        mock_doc.metadata = {
            "namespace": "main|memories",
            "key": "key1",
            "value": '{"text": "Test"}',
        }
        mock_sqlite.return_value.similarity_search_with_score.return_value = [(mock_doc, 0.9)]

        mock_embeddings = MagicMock()
        store = SQLiteVecStore(db_file=":memory:", table="test", embeddings=mock_embeddings)

        result = store.get(("main", "memories"), "key1")

        assert result is not None
        assert result.key == "key1"

    @patch("app.services.db.rag_service.SQLiteVec")
    def test_sqlite_vec_store_search(self, mock_sqlite):
        """Test SQLiteVecStore search operation."""
        mock_conn = MagicMock()
        mock_sqlite.create_connection.return_value = mock_conn

        # Mock search results
        from unittest.mock import Mock as MockDoc

        mock_doc1 = MockDoc()
        mock_doc1.metadata = {
            "namespace": "main|memories",
            "key": "key1",
            "value": '{"text": "Memory 1"}',
        }
        mock_doc2 = MockDoc()
        mock_doc2.metadata = {
            "namespace": "main|memories",
            "key": "key2",
            "value": '{"text": "Memory 2"}',
        }
        mock_sqlite.return_value.similarity_search_with_score.return_value = [
            (mock_doc1, 0.9),
            (mock_doc2, 0.8),
        ]

        mock_embeddings = MagicMock()
        store = SQLiteVecStore(db_file=":memory:", table="test", embeddings=mock_embeddings)

        results = store.search(("main", "memories"), query="test", limit=2)

        assert len(results) == 2
        assert results[0].key == "key1"
        assert results[1].key == "key2"


class TestEmbeddingModelManagement:
    """Test embedding model change detection."""

    @patch("app.services.db.rag_service.SQLiteVec")
    def test_check_and_update_embedding_model_no_change(self, mock_sqlite):
        """Test when embedding model hasn't changed."""
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_cursor.fetchone.return_value = ("openai:text-embedding-3-small:openai",)
        mock_conn.execute.return_value = mock_cursor
        mock_sqlite.create_connection.return_value = mock_conn

        mock_store = MagicMock()
        mock_store.db_file = ":memory:"
        mock_store.table = "test"

        model_info = {"type": "openai", "model_name": "text-embedding-3-small", "version": "openai"}

        result = check_and_update_embedding_model(mock_store, model_info)

        assert result is False  # No re-embedding needed

    @patch("app.services.db.rag_service.SQLiteVec")
    @patch("app.services.db.rag_service.os.path.exists")
    def test_check_and_update_embedding_model_change(self, mock_exists, mock_sqlite):
        """Test when embedding model has changed."""
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        # First call: check signature (returns old signature)
        # Second call: check table exists (returns True)
        mock_cursor.fetchone.side_effect = [("huggingface:all-MiniLM-L6-v2:local",), (True,), None]
        mock_conn.execute.return_value = mock_cursor
        mock_conn.cursor.return_value = mock_cursor
        mock_sqlite.create_connection.return_value = mock_conn

        mock_store = MagicMock()
        mock_store.db_file = ":memory:"
        mock_store.table = "test"

        # Mock existing data
        mock_cursor.fetchall.return_value = [(1, "test text", '{"key": "value"}')]

        mock_exists.return_value = True

        with (
            patch("app.services.db.rag_service.os.remove"),
            patch("app.services.db.rag_service.SQLiteVec.from_texts"),
        ):
            mock_emb = MagicMock()

            model_info = {
                "type": "openai",
                "model_name": "text-embedding-3-small",
                "version": "openai",
            }

            result = check_and_update_embedding_model(mock_store, model_info, embeddings=mock_emb)

            assert result is True  # Re-embedding was performed
