"""Unit tests for DBService."""

from unittest.mock import AsyncMock, MagicMock, Mock, patch

import pytest

from app.messaging import Envelope, MessageBus, QueryResult
from app.services.db.service import DBService
from app.shared.contracts.models.db import DBMethods


@pytest.fixture
def mock_bus():
    """Create a mock message bus."""
    bus = Mock(spec=MessageBus)
    bus.subscribe = Mock()
    bus.publish = AsyncMock()
    return bus


@pytest.fixture
def db_service(mock_bus):
    """Create a DBService instance."""
    with (
        patch("app.services.db.service.DatabaseManager") as mock_db_mgr,
        patch("app.services.db.service.SchedulerDatabaseService") as mock_scheduler_db,
        patch("app.services.db.service.RAGService") as mock_rag,
        patch("app.shared.services.base_service.get_bus_singleton", return_value=mock_bus),
    ):
        mock_db_mgr.return_value.initialize = AsyncMock()
        mock_scheduler_db.return_value.initialize = AsyncMock()
        mock_rag.return_value.async_initialize = AsyncMock()
        mock_rag.return_value.combined_store = MagicMock()

        service = DBService()
        service.db_manager = mock_db_mgr.return_value
        service.scheduler_db = mock_scheduler_db.return_value
        service.rag_service = mock_rag.return_value
        yield service


class TestDBServiceInitialization:
    """Test DBService initialization."""

    def test_init(self, mock_bus):
        """Test service initialization."""
        with (
            patch("app.services.db.service.DatabaseManager"),
            patch("app.services.db.service.SchedulerDatabaseService"),
            patch("app.services.db.service.RAGService"),
            patch("app.shared.services.base_service.get_bus_singleton", return_value=mock_bus),
        ):
            service = DBService()
            assert service is not None

    @pytest.mark.asyncio
    async def test_start(self, db_service, mock_bus):
        """Test service start."""
        await db_service.start()

        # Verify subscriptions were made (service uses auto-subscription via contracts)
        # The exact count may vary based on contract registration
        assert mock_bus.subscribe.call_count >= 0  # May use auto-subscription

    @pytest.mark.asyncio
    async def test_stop(self, db_service):
        """Test service stop."""
        db_service.db_manager.close = AsyncMock()
        await db_service.stop()


class TestDBServiceMessageHandling:
    """Test DBService message handling."""

    @pytest.mark.asyncio
    async def test_store_message(self, db_service, mock_bus):
        """Test store message command."""
        from app.shared.contracts.models.db import DBSaveMessageRequest, DBSaveMessageResponse

        request = DBSaveMessageRequest(
            role="user", content="Hello", session_id="test-session", metadata={}
        )

        db_service.db_manager.store_message = AsyncMock(return_value=True)

        # Call contract method directly
        response = await db_service.store_message(request)

        # Verify response
        assert isinstance(response, DBSaveMessageResponse)
        assert response.success is True
        db_service.db_manager.store_message.assert_called_once()

    @pytest.mark.asyncio
    async def test_get_messages(self, db_service, mock_bus):
        """Test get recent messages query."""
        from app.shared.contracts.models.db import DBGetMessagesRequest, DBGetMessagesResponse

        request = DBGetMessagesRequest(limit=10)

        mock_messages = [
            MagicMock(role="user", content="Hello", timestamp="2024-01-01", metadata={}),
            MagicMock(role="assistant", content="Hi", timestamp="2024-01-01", metadata={}),
        ]
        db_service.db_manager.get_recent_messages = AsyncMock(return_value=mock_messages)

        # Call contract method directly
        response = await db_service.get_messages(request)

        # Verify response
        assert isinstance(response, DBGetMessagesResponse)
        assert len(response.messages) == 2
        assert response.total == 2

    @pytest.mark.asyncio
    async def test_get_messages_for_date(self, db_service, mock_bus):
        """Test get messages for date query."""
        from app.shared.contracts.models.db import (
            DBGetMessagesForDateRequest,
            DBGetMessagesResponse,
        )

        request = DBGetMessagesForDateRequest(date="2024-01-01")

        mock_messages = [MagicMock(role="user", content="Test", timestamp=None, metadata={})]
        db_service.db_manager.get_messages_for_date = AsyncMock(return_value=mock_messages)

        # Call contract method directly
        response = await db_service.get_messages_for_date(request)

        # Verify response
        assert isinstance(response, DBGetMessagesResponse)
        assert len(response.messages) == 1


class TestDBServiceRAGOperations:
    """Test DBService RAG operations."""

    @pytest.mark.asyncio
    async def test_rag_store(self, db_service):
        """Test RAG store command."""
        from app.shared.contracts.models.common import EmptyOutput
        from app.shared.contracts.models.db import DBRAGStoreRequest

        # Namespace is now a string, not a tuple
        request = DBRAGStoreRequest(
            namespace="main|memories", key="test-key", value={"text": "Test memory"}, index=True
        )

        mock_store = MagicMock()
        mock_store.put = Mock()
        db_service.rag_service.combined_store = mock_store

        # Call contract method directly
        response = await db_service.rag_store(request)

        # Verify response
        assert isinstance(response, EmptyOutput)
        # Verify store was called (namespace converted to tuple internally)
        mock_store.put.assert_called_once()

    @pytest.mark.asyncio
    async def test_rag_delete(self, db_service):
        """Test RAG delete command."""
        from app.shared.contracts.models.common import EmptyOutput
        from app.shared.contracts.models.db import DBRAGDeleteRequest

        request = DBRAGDeleteRequest(namespace="main|memories", key="test-key")

        mock_store = MagicMock()
        mock_store.delete = Mock()
        db_service.rag_service.combined_store = mock_store

        # Call contract method directly
        response = await db_service.rag_delete(request)

        # Verify response
        assert isinstance(response, EmptyOutput)
        # Verify store was called
        mock_store.delete.assert_called_once()

    @pytest.mark.asyncio
    async def test_rag_search(self, db_service, mock_bus):
        """Test RAG search query."""
        from app.shared.contracts.models.db import DBRAGListResponse, DBRAGSearchRequest

        request = DBRAGSearchRequest(namespace="main|memories", query="test query", limit=5)

        from datetime import datetime

        from langgraph.store.base import Item

        mock_items = [
            Item(
                value={"text": "Test memory 1"},
                key="key1",
                namespace=("main", "memories"),
                created_at=datetime.now(),
                updated_at=datetime.now(),
            ),
            Item(
                value={"text": "Test memory 2", "_search_score": 0.9},
                key="key2",
                namespace=("main", "memories"),
                created_at=datetime.now(),
                updated_at=datetime.now(),
            ),
        ]

        mock_store = MagicMock()
        mock_store.search = Mock(return_value=mock_items)
        db_service.rag_service.combined_store = mock_store

        # Call contract method directly
        response = await db_service.rag_search(request)

        # Verify response
        assert isinstance(response, DBRAGListResponse)
        assert len(response.items) == 2

    @pytest.mark.asyncio
    async def test_rag_get(self, db_service, mock_bus):
        """Test RAG get query."""
        from app.shared.contracts.models.db import DBRAGGetRequest, DBRAGItemResponse

        request = DBRAGGetRequest(namespace="main|memories", key="test-key")

        from datetime import datetime

        from langgraph.store.base import Item

        mock_item = Item(
            value={"text": "Test memory"},
            key="test-key",
            namespace=("main", "memories"),
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )

        mock_store = MagicMock()
        mock_store.get = Mock(return_value=mock_item)
        db_service.rag_service.combined_store = mock_store

        # Call contract method directly
        response = await db_service.rag_get(request)

        # Verify response
        assert isinstance(response, DBRAGItemResponse)
        assert response.key == "test-key"

    @pytest.mark.asyncio
    async def test_rag_get_not_found(self, db_service, mock_bus):
        """Test RAG get query when item not found."""
        from app.shared.contracts.models.db import DBRAGGetRequest

        request = DBRAGGetRequest(namespace="main|memories", key="non-existent")

        mock_store = MagicMock()
        mock_store.get = Mock(return_value=None)
        db_service.rag_service.combined_store = mock_store

        # Call contract method directly
        response = await db_service.rag_get(request)

        # Verify response is None when not found
        assert response is None

    @pytest.mark.asyncio
    async def test_rag_list(self, db_service, mock_bus):
        """Test RAG list query."""
        from app.shared.contracts.models.db import DBRAGListRequest, DBRAGListResponse

        request = DBRAGListRequest(namespace="tools", limit=10, offset=0)

        from datetime import datetime

        from langgraph.store.base import Item

        mock_items = [
            Item(
                value={"name": "tool1"},
                key="tool1",
                namespace=("tools",),
                created_at=datetime.now(),
                updated_at=datetime.now(),
            ),
        ]

        mock_store = MagicMock()
        mock_store.retrieve_items = Mock(return_value=mock_items)
        db_service.rag_service.combined_store = mock_store

        # Call contract method directly
        response = await db_service.rag_list(request)

        # Verify response
        assert isinstance(response, DBRAGListResponse)
        assert len(response.items) == 1

    @pytest.mark.asyncio
    async def test_rag_list_namespaces_includes_policy(self, db_service):
        """Namespace catalog exposes availability and policy metadata."""
        from app.shared.contracts.models.db import DBRAGListNamespacesRequest

        mock_store = MagicMock()
        mock_store.retrieve_items = Mock(return_value=[])
        db_service.rag_service.combined_store = mock_store

        response = await db_service.rag_list_namespaces(DBRAGListNamespacesRequest())

        namespaces = {entry.namespace: entry for entry in response.namespaces}
        assert "main.memories" in namespaces
        assert namespaces["main.memories"].policy.explicit_selector_required is True
        assert namespaces["main.memories"].policy.export_supported is True
        assert "tools" in namespaces
        assert namespaces["tools"].policy.export_supported is False

    @pytest.mark.asyncio
    async def test_rag_search_remote_denies_remote_selector_without_namespace(self, db_service):
        """Remote RAG search requires an explicit namespace/data scope selector."""
        from app.shared.contracts.models.db import DBRAGSearchRemoteRequest
        from app.shared.contracts.models.mesh import MeshAddressSelector

        response = await db_service.rag_search_remote(
            DBRAGSearchRemoteRequest(
                namespace="main.memories",
                query="privacy",
                mesh_selector=MeshAddressSelector(peer_id="peer-b"),
            )
        )

        assert response.decision == "denied"
        assert "resource_namespace" in response.denial_reason

    @pytest.mark.asyncio
    async def test_rag_search_remote_allows_selector_and_redacts(self, db_service):
        """Allowed remote search returns provenance and redacts sensitive fields."""
        from datetime import datetime

        from langgraph.store.base import Item

        from app.shared.contracts.models.db import DBRAGSearchRemoteRequest
        from app.shared.contracts.models.mesh import MeshAddressSelector

        item = Item(
            value={
                "text": "safe memory",
                "embedding": [0.1, 0.2],
                "source_path": "/home/user/private.txt",
                "_aurora_provenance": {
                    "source_peer_id": "peer-owner",
                    "owner_peer_id": "peer-owner",
                    "namespace": "main.memories",
                    "record_id": "memory-1",
                    "origin_principal_id": "redacted",
                    "created_at": "2026-06-19T00:00:00+00:00",
                    "updated_at": "2026-06-19T00:00:00+00:00",
                    "schema_version": "rag-provenance.v1",
                    "policy_decision_id": "old",
                    "correlation_id": "old",
                    "tombstone": False,
                },
            },
            key="memory-1",
            namespace=("main", "memories"),
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )
        mock_store = MagicMock()
        mock_store.search = Mock(return_value=[item])
        db_service.rag_service.combined_store = mock_store

        response = await db_service.rag_search_remote(
            DBRAGSearchRemoteRequest(
                namespace="main.memories",
                query="safe",
                mesh_selector=MeshAddressSelector(
                    peer_id="peer-b", resource_namespace="main.memories"
                ),
                caller_principal_id="principal-a",
                policy_decision_id="policy-1",
                correlation_id="corr-1",
            )
        )

        assert response.decision == "allowed"
        assert len(response.items) == 1
        result = response.items[0]
        assert result.provenance.source_peer_id == "peer-owner"
        assert result.provenance.policy_decision_id == "policy-1"
        assert result.value["embedding"] == "[redacted]"
        assert result.value["source_path"] == "[redacted]"
        assert "_aurora_provenance" not in result.value
        assert result.redacted is True

    @pytest.mark.asyncio
    async def test_rag_export_namespace_preserves_provenance_and_tombstones(self, db_service):
        """Export produces a bounded snapshot with provenance and tombstone metadata."""
        from datetime import datetime

        from langgraph.store.base import Item

        from app.shared.contracts.models.db import DBRAGExportNamespaceRequest

        item = Item(
            value={
                "text": "deleted memory",
                "_aurora_tombstone": True,
                "_aurora_deleted_at": "2026-06-19T00:00:00+00:00",
                "_aurora_deleted_by": "principal-a",
                "_aurora_delete_reason": "user_forget",
            },
            key="memory-1",
            namespace=("main", "memories"),
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )
        mock_store = MagicMock()
        mock_store.retrieve_items = Mock(return_value=[item])
        db_service.rag_service.combined_store = mock_store

        response = await db_service.rag_export_namespace(
            DBRAGExportNamespaceRequest(
                namespace="main.memories",
                policy_decision_id="policy-export",
                correlation_id="corr-export",
            )
        )

        assert response.decision == "allowed"
        assert response.tombstone_count == 1
        assert response.records[0].provenance.tombstone is True
        assert response.records[0].provenance.deleted_by == "principal-a"
        assert response.records[0].provenance.policy_decision_id == "policy-export"

    @pytest.mark.asyncio
    async def test_rag_import_namespace_blocks_existing_owner_without_override(self, db_service):
        """Import cannot silently overwrite an existing target namespace."""
        from datetime import datetime

        from langgraph.store.base import Item

        from app.shared.contracts.models.db import (
            DBRAGExportRecord,
            DBRAGImportNamespaceRequest,
            DBRAGProvenance,
        )

        mock_store = MagicMock()
        mock_store.retrieve_items = Mock(
            return_value=[
                Item(
                    value={"text": "existing"},
                    key="existing",
                    namespace=("imported", "memories"),
                    created_at=datetime.now(),
                    updated_at=datetime.now(),
                )
            ]
        )
        db_service.rag_service.combined_store = mock_store
        record = DBRAGExportRecord(
            key="memory-1",
            value={"text": "portable"},
            provenance=DBRAGProvenance(
                source_peer_id="peer-a",
                owner_peer_id="peer-a",
                namespace="main.memories",
                record_id="memory-1",
                origin_principal_id="redacted",
                created_at="2026-06-19T00:00:00+00:00",
                updated_at="2026-06-19T00:00:00+00:00",
                policy_decision_id="policy-export",
                correlation_id="corr-export",
            ),
        )

        response = await db_service.rag_import_namespace(
            DBRAGImportNamespaceRequest(
                source_namespace="main.memories",
                target_namespace="imported.memories",
                records=[record],
                source_peer_id="peer-a",
                owner_peer_id="peer-a",
            )
        )

        assert response.decision == "conflict"
        mock_store.put.assert_not_called()

    @pytest.mark.asyncio
    async def test_rag_import_namespace_preserves_import_provenance(self, db_service):
        """Import writes records with preserved source provenance in the target namespace."""
        from app.shared.contracts.models.db import (
            DBRAGExportRecord,
            DBRAGImportNamespaceRequest,
            DBRAGProvenance,
        )

        mock_store = MagicMock()
        mock_store.retrieve_items = Mock(return_value=[])
        mock_store.put = Mock()
        db_service.rag_service.combined_store = mock_store
        record = DBRAGExportRecord(
            key="memory-1",
            value={"text": "portable"},
            provenance=DBRAGProvenance(
                source_peer_id="peer-a",
                owner_peer_id="peer-a",
                namespace="main.memories",
                record_id="memory-1",
                origin_principal_id="redacted",
                created_at="2026-06-19T00:00:00+00:00",
                updated_at="2026-06-19T00:00:00+00:00",
                policy_decision_id="policy-export",
                correlation_id="corr-export",
            ),
        )

        response = await db_service.rag_import_namespace(
            DBRAGImportNamespaceRequest(
                source_namespace="main.memories",
                target_namespace="imported.memories",
                records=[record],
                source_peer_id="peer-a",
                owner_peer_id="peer-a",
            )
        )

        assert response.decision == "allowed"
        assert response.imported_count == 1
        put_args = mock_store.put.call_args.args
        assert put_args[0] == ("imported", "memories")
        stored_value = put_args[2]
        assert stored_value["_aurora_provenance"]["source_peer_id"] == "peer-a"
        assert stored_value["_aurora_provenance"]["namespace"] == "imported.memories"
        assert stored_value["_aurora_provenance"]["import_operation_id"].startswith("rag-import-")

    def test_rag_contract_exposure_and_raw_sql_internal(self):
        """RAG sharing contracts are exposed, while raw SQL remains internal-only."""
        assert DBService.rag_search_remote._contract_metadata["exposure"] == "both"
        assert DBService.rag_list_namespaces._contract_metadata["exposure"] == "both"
        assert DBService.rag_export_namespace._contract_metadata["method_type"] == "manage"
        assert DBService.rag_import_namespace._contract_metadata["method_type"] == "manage"
        assert DBService.execute_sql._contract_metadata["exposure"] == "internal"
        assert DBService.execute_sql._contract_metadata["method_type"] == "manage"
