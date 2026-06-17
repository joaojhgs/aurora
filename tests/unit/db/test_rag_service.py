"""Unit tests for RAGService."""

import tempfile
import types
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, Mock, patch

import pytest

from app.services.db.rag_service import (
    RAG_SYNC_METADATA_KEY,
    CombinedSQLiteVecStore,
    RAGService,
    SQLiteVecStore,
    async_get_embeddings,
    check_and_update_embedding_model,
    get_embedding_model_signature,
    make_rag_tombstone,
    normalize_rag_namespace,
)
from app.shared.contracts.models.db import DBRAGReplicatedItem


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

    def test_normalize_namespace_supports_legacy_pipe_separator(self):
        """Test RAG namespace normalization for existing callers."""
        assert normalize_rag_namespace("main|memories") == ("main", "memories")
        assert normalize_rag_namespace("main.memories") == ("main", "memories")

    @patch("app.services.db.rag_service.config_api")
    @pytest.mark.asyncio
    async def test_get_embeddings_local(self, mock_config):
        """Test getting local embeddings."""
        mock_config.aget = AsyncMock(
            return_value=types.SimpleNamespace(embeddings=types.SimpleNamespace(use_local=True))
        )
        mock_emb = MagicMock()
        mock_hf_module = types.SimpleNamespace(HuggingFaceEmbeddings=Mock(return_value=mock_emb))

        with (
            patch("app.services.db.rag_service._async_wait_for_config_service", return_value=True),
            patch.dict("sys.modules", {"langchain_huggingface": mock_hf_module}),
        ):
            embeddings, model_info = await async_get_embeddings()

            assert model_info["type"] == "huggingface"
            assert model_info["model_name"] == "all-MiniLM-L6-v2"
            mock_hf_module.HuggingFaceEmbeddings.assert_called_once_with(
                model_name="all-MiniLM-L6-v2"
            )

    @patch("app.services.db.rag_service.config_api")
    @pytest.mark.asyncio
    async def test_get_embeddings_openai(self, mock_config):
        """Test getting OpenAI embeddings."""
        mock_config.aget = AsyncMock(
            return_value=types.SimpleNamespace(embeddings=types.SimpleNamespace(use_local=False))
        )

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


class TestRAGReplication:
    """Test namespace-scoped RAG replication semantics."""

    def test_last_writer_wins_conflict_resolution(self):
        """Newer replicated items win; older items are skipped."""
        local = DBRAGReplicatedItem(
            namespace="main.memories",
            key="k1",
            value={"text": "local"},
            source_peer_id="peer-a",
            owner_peer_id="peer-a",
            created_at="2026-06-17T10:00:00Z",
            updated_at="2026-06-17T10:10:00Z",
            policy_decision_id="policy-1",
            correlation_id="corr-1",
            sync_operation_id="sync-1",
        )
        incoming = DBRAGReplicatedItem(
            namespace="main.memories",
            key="k1",
            value={"text": "remote"},
            source_peer_id="peer-b",
            owner_peer_id="peer-a",
            created_at="2026-06-17T10:00:00Z",
            updated_at="2026-06-17T10:11:00Z",
            policy_decision_id="policy-2",
            correlation_id="corr-2",
            sync_operation_id="sync-2",
        )

        winner = RAGService.resolve_replication_conflict(
            local=local, incoming=incoming, conflict_mode="last_writer_wins"
        )

        assert winner is incoming

    def test_reject_on_conflict_preserves_local_item(self):
        """Strict conflict mode inserts only missing records."""
        local = DBRAGReplicatedItem(
            namespace="main.memories",
            key="k1",
            value={"text": "local"},
            source_peer_id="peer-a",
            owner_peer_id="peer-a",
            created_at="2026-06-17T10:00:00Z",
            updated_at="2026-06-17T10:10:00Z",
            policy_decision_id="policy-1",
            correlation_id="corr-1",
            sync_operation_id="sync-1",
        )
        incoming = local.model_copy(update={"source_peer_id": "peer-b"})

        winner = RAGService.resolve_replication_conflict(
            local=local, incoming=incoming, conflict_mode="reject_on_conflict"
        )

        assert winner is None

    def test_make_rag_tombstone_represents_delete_semantics(self):
        """Tombstones carry delete provenance instead of raw table deletes."""
        tombstone = make_rag_tombstone(
            namespace="main.memories",
            key="forgotten",
            source_peer_id="peer-a",
            owner_peer_id="peer-a",
            origin_principal_id="user-1",
            policy_decision_id="policy-1",
            correlation_id="corr-1",
            sync_operation_id="sync-1",
            deleted_by="user-1",
            reason="forget_request",
        )

        assert tombstone.tombstone is not None
        assert tombstone.value is None
        assert tombstone.tombstone.reason == "forget_request"

    def test_import_namespace_stores_tombstone_with_metadata(self):
        """Importing a tombstone preserves provenance in stored value metadata."""
        service = RAGService()
        service._initialized = True
        mock_store = MagicMock()
        mock_store.get.return_value = None
        service._combined_store = mock_store
        tombstone = make_rag_tombstone(
            namespace="main.memories",
            key="forgotten",
            source_peer_id="peer-a",
            owner_peer_id="peer-a",
            origin_principal_id="user-1",
            policy_decision_id="policy-1",
            correlation_id="corr-1",
            sync_operation_id="sync-1",
            deleted_by="user-1",
        )

        response = service.import_namespace(namespace="main.memories", items=[tombstone])

        assert response.tombstoned == 1
        stored_value = mock_store.put.call_args.args[2]
        assert stored_value[RAG_SYNC_METADATA_KEY]["tombstone"]["deleted_by"] == "user-1"

    def test_export_namespace_skips_sensitive_values(self):
        """Export refuses obvious credential-bearing memory values."""
        from datetime import datetime

        from langgraph.store.base import Item

        service = RAGService()
        service._initialized = True
        mock_store = MagicMock()
        mock_store.retrieve_items.return_value = [
            Item(
                value={"text": "ok"},
                key="safe",
                namespace=("main", "memories"),
                created_at=datetime.now(),
                updated_at=datetime.now(),
            ),
            Item(
                value={"text": "bad", "token": "secret"},
                key="unsafe",
                namespace=("main", "memories"),
                created_at=datetime.now(),
                updated_at=datetime.now(),
            ),
        ]
        service._combined_store = mock_store

        snapshot = service.export_namespace(
            namespace="main.memories",
            source_peer_id="peer-a",
            owner_peer_id="peer-a",
            origin_principal_id="user-1",
            policy_decision_id="policy-1",
            correlation_id="corr-1",
            sync_operation_id="sync-1",
        )

        assert [item.key for item in snapshot] == ["safe"]
        assert snapshot[0].source_peer_id == "peer-a"

    def test_mocked_two_peer_export_import_flow(self):
        """A peer can export a namespace snapshot that another peer imports."""
        from datetime import datetime

        from langgraph.store.base import Item

        source = RAGService()
        source._initialized = True
        source_store = MagicMock()
        source_store.retrieve_items.return_value = [
            Item(
                value={"text": "portable memory"},
                key="memory-1",
                namespace=("main", "memories"),
                created_at=datetime.now(),
                updated_at=datetime.now(),
            )
        ]
        source._combined_store = source_store

        snapshot = source.export_namespace(
            namespace="main.memories",
            source_peer_id="peer-a",
            owner_peer_id="peer-a",
            origin_principal_id="user-1",
            policy_decision_id="policy-1",
            correlation_id="corr-1",
            sync_operation_id="sync-1",
        )

        target = RAGService()
        target._initialized = True
        target_store = MagicMock()
        target_store.get.return_value = None
        target._combined_store = target_store

        response = target.import_namespace(namespace="main.memories", items=snapshot)

        assert response.imported == 1
        target_store.put.assert_called_once()
        stored_value = target_store.put.call_args.args[2]
        assert stored_value["text"] == "portable memory"
        assert stored_value[RAG_SYNC_METADATA_KEY]["source_peer_id"] == "peer-a"
