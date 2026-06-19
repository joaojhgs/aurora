"""Integration coverage for mesh-safe RAG namespace export/import policy."""

from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, Mock, patch

import pytest
from langgraph.store.base import Item

from app.services.db.service import DBService
from app.shared.contracts.models.db import (
    DBRAGExportNamespaceRequest,
    DBRAGImportNamespaceRequest,
)


def _db_service_with_store(store: MagicMock) -> DBService:
    with (
        patch("app.services.db.service.DatabaseManager") as mock_db_mgr,
        patch("app.services.db.service.SchedulerDatabaseService") as mock_scheduler_db,
        patch("app.services.db.service.RAGService") as mock_rag,
        patch("app.shared.services.base_service.get_bus_singleton"),
    ):
        mock_db_mgr.return_value.initialize = AsyncMock()
        mock_scheduler_db.return_value.initialize = AsyncMock()
        mock_rag.return_value.async_initialize = AsyncMock()
        mock_rag.return_value.is_initialized = True
        mock_rag.return_value.combined_store = store

        service = DBService()
        service.db_manager = mock_db_mgr.return_value
        service.scheduler_db = mock_scheduler_db.return_value
        service.rag_service = mock_rag.return_value
        return service


@pytest.mark.asyncio
@pytest.mark.integration
async def test_two_peer_rag_namespace_export_import_preserves_provenance():
    """One peer can export a namespace snapshot that another imports with provenance."""
    provider_store = MagicMock()
    provider_store.retrieve_items = Mock(
        return_value=[
            Item(
                value={"text": "portable memory", "embedding": [0.1, 0.2]},
                key="memory-1",
                namespace=("main", "memories"),
                created_at=datetime.now(),
                updated_at=datetime.now(),
            )
        ]
    )
    consumer_store = MagicMock()
    consumer_store.retrieve_items = Mock(return_value=[])
    consumer_store.put = Mock()

    provider = _db_service_with_store(provider_store)
    consumer = _db_service_with_store(consumer_store)

    exported = await provider.rag_export_namespace(
        DBRAGExportNamespaceRequest(
            namespace="main.memories",
            policy_decision_id="policy-export",
            correlation_id="corr-export",
        )
    )
    imported = await consumer.rag_import_namespace(
        DBRAGImportNamespaceRequest(
            source_namespace=exported.namespace,
            target_namespace="imported.peer_a.memories",
            records=exported.records,
            source_peer_id=exported.source_peer_id,
            owner_peer_id=exported.owner_peer_id,
            policy_decision_id="policy-import",
            correlation_id="corr-import",
        )
    )

    assert exported.decision == "allowed"
    assert exported.records[0].redacted is True
    assert exported.records[0].value["embedding"] == "[redacted]"
    assert imported.decision == "allowed"
    assert imported.imported_count == 1
    put_args = consumer_store.put.call_args.args
    assert put_args[0] == ("imported", "peer_a", "memories")
    assert put_args[2]["_aurora_provenance"]["source_peer_id"] == "local"
    assert put_args[2]["_aurora_provenance"]["namespace"] == "imported.peer_a.memories"
    assert put_args[2]["_aurora_provenance"]["import_operation_id"].startswith("rag-import-")
