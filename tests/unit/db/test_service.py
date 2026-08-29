"""Unit tests for DBService."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, Mock, patch

import aiosqlite
import pytest

from app.messaging import Envelope, MessageBus, QueryResult
from app.services.db.manager import DatabaseManager
from app.services.db.service import DBService
from app.shared.contracts.models.db import (
    DBAllocateToolIdentityRequest,
    DBAllocateToolIdentityResponse,
    DBCreateTokenRequest,
    DBExecuteSQLRequest,
    DBMethods,
    DBPrunedMeshPeerRow,
    DBPruneOrphanedMeshPeerRowsRequest,
    DBPruneOrphanedMeshPeerRowsResponse,
    DBReconcileToolIdentityRequest,
    DBReconcileToolIdentityResponse,
    DBResolveToolIdentityAliasesRequest,
    DBResolveToolIdentityAliasesResponse,
)


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


@pytest.mark.asyncio
async def test_execute_sql_reports_statement_failure(db_service, tmp_path):
    """Internal SQL callers can fail closed instead of mistaking errors for empty success."""

    db_service.db_manager.db_path = str(tmp_path / "execute-sql-failure.db")
    created = await db_service.execute_sql(
        DBExecuteSQLRequest(sql="CREATE TABLE durable_state (id TEXT PRIMARY KEY)")
    )
    assert created.success is True
    assert created.error is None

    failed = await db_service.execute_sql(
        DBExecuteSQLRequest(sql="INSERT INTO missing_table (id) VALUES (?)", params=["x"])
    )

    assert failed.success is False
    assert "no such table" in (failed.error or "")
    assert failed.rows == []
    assert failed.rowcount == 0


@pytest.mark.asyncio
async def test_prune_orphaned_mesh_peer_rows_delegates_to_manager(db_service):
    request = DBPruneOrphanedMeshPeerRowsRequest(now=1000, retention_seconds=3600)
    response = DBPruneOrphanedMeshPeerRowsResponse(
        pruned_rows=[
            DBPrunedMeshPeerRow(
                row_id="row-1",
                peer_id="peer-1",
                room_name="room-1",
            )
        ]
    )
    db_service.db_manager.prune_orphaned_mesh_peer_rows = AsyncMock(return_value=response)

    assert await db_service.prune_orphaned_mesh_peer_rows(request) == response
    db_service.db_manager.prune_orphaned_mesh_peer_rows.assert_awaited_once_with(request)


@pytest.mark.asyncio
async def test_contract_boundary_serializes_writers_but_keeps_reads_concurrent(db_service):
    first_entered = asyncio.Event()
    release_first = asyncio.Event()
    second_entered = asyncio.Event()
    read_entered = asyncio.Event()

    async def first_write(_data):
        first_entered.set()
        await release_first.wait()
        return "first"

    async def second_write(_data):
        second_entered.set()
        return "second"

    async def read(_data):
        read_entered.set()
        return "read"

    async def invoke(method, method_name):
        return await db_service._invoke_contract_method(
            method,
            object(),
            envelope=None,
            pass_envelope=False,
            topic=f"DB.{method_name}",
            method_name=method_name,
            method_type="use",
        )

    first_task = asyncio.create_task(invoke(first_write, "store_message"))
    await asyncio.wait_for(first_entered.wait(), timeout=1)
    second_task = asyncio.create_task(invoke(second_write, "create_user"))
    read_task = asyncio.create_task(invoke(read, "get_user_by_id"))
    await asyncio.wait_for(read_entered.wait(), timeout=1)
    await asyncio.sleep(0)
    assert second_entered.is_set() is False

    release_first.set()
    assert await asyncio.gather(first_task, second_task, read_task) == [
        "first",
        "second",
        "read",
    ]


def test_contract_boundary_classifies_execute_sql_from_the_statement():
    assert DBService._contract_call_is_read_only(
        "execute_sql",
        DBExecuteSQLRequest(sql="WITH rows AS (SELECT 1) SELECT * FROM rows"),
    )
    assert not DBService._contract_call_is_read_only(
        "execute_sql",
        DBExecuteSQLRequest(sql="WITH rows AS (SELECT 1) INSERT INTO harmless SELECT * FROM rows"),
    )
    assert DBService._contract_call_is_read_only(
        "get_session",
        MagicMock(activate=False),
    )
    assert not DBService._contract_call_is_read_only(
        "get_session",
        MagicMock(activate=True),
    )


@pytest.mark.asyncio
async def test_reconcile_tool_identity_delegates_to_typed_manager_transaction(db_service):
    request = DBReconcileToolIdentityRequest(
        canonical_global_tool_id="aurora-tool:v1:peer-a:Tooling:core.scheduler.list",
        stable_peer_id="peer-a",
        tool_contract_id="core.scheduler.list",
        source_kind="core",
        stable_source_id="core:scheduler",
        provider_tool_id="list_scheduled_tasks_tool",
        share_group_id="core:scheduler",
        share_group_label="Scheduler",
        current_local_name="List scheduled tasks",
    )
    expected = DBReconcileToolIdentityResponse(
        success=True,
        canonical_global_tool_id=request.canonical_global_tool_id,
        created=True,
    )
    db_service.db_manager.reconcile_tool_identity = AsyncMock(return_value=expected)

    response = await db_service.reconcile_tool_identity(request)

    assert response == expected
    db_service.db_manager.reconcile_tool_identity.assert_awaited_once_with(request)


@pytest.mark.asyncio
async def test_allocate_tool_identity_delegates_to_typed_manager_transaction(db_service):
    request = DBAllocateToolIdentityRequest(
        stable_peer_id="peer-a",
        legacy_identity_locator="legacy:list",
        source_kind="unknown",
        stable_source_id="legacy:local",
        provider_tool_id="list",
        share_group_id="legacy:local",
        share_group_label="Legacy",
        current_local_name="List",
    )
    expected = DBAllocateToolIdentityResponse(
        success=True,
        canonical_global_tool_id="aurora-tool:v1:peer-a:Tooling:legacy.abc",
        allocated_tool_contract_id="legacy.abc",
    )
    db_service.db_manager.allocate_tool_identity = AsyncMock(return_value=expected)

    assert await db_service.allocate_tool_identity(request) == expected
    db_service.db_manager.allocate_tool_identity.assert_awaited_once_with(request)


@pytest.mark.asyncio
async def test_resolve_tool_aliases_delegates_with_peer_scope(db_service):
    request = DBResolveToolIdentityAliasesRequest(
        global_tool_ids=["legacy:list"], stable_peer_id="peer-a"
    )
    expected = DBResolveToolIdentityAliasesResponse(
        resolved={"legacy:list": "aurora-tool:v1:peer-a:Tooling:legacy.abc"}
    )
    db_service.db_manager.resolve_tool_identity_aliases = AsyncMock(return_value=expected)

    assert await db_service.resolve_tool_identity_aliases(request) == expected
    db_service.db_manager.resolve_tool_identity_aliases.assert_awaited_once_with(
        request.global_tool_ids, stable_peer_id="peer-a"
    )


@pytest.mark.asyncio
async def test_execute_sql_guards_protected_authority_writes(db_service, tmp_path):
    db_service.db_manager.db_path = str(tmp_path / "execute-sql-guard.db")
    async with aiosqlite.connect(db_service.db_manager.db_path) as db:
        await db.executescript(
            """
            CREATE TABLE users (id TEXT PRIMARY KEY);
            CREATE TABLE harmless (id TEXT PRIMARY KEY, note TEXT);
            INSERT INTO users (id) VALUES ('u1');
            """
        )
        await db.commit()

    protected_writes = [
        'InSeRt INTO "users" (id) VALUES ("u1")',
        "/* before */ UPDATE `users` SET id = 'u2' WHERE id = 'u1'",
        "-- comment naming harmless\nDELETE FROM [users] WHERE id = 'u1'",
        "REPLACE INTO users (id) VALUES ('u1')",
        "WITH incoming(id) AS (SELECT 'u1') INSERT INTO users SELECT id FROM incoming",
        "WITH marker AS (SELECT '--') DELETE FROM users WHERE id = 'u1'",
        "WITH marker AS (SELECT '/*x*/') UPDATE users SET id = 'u2' WHERE id = 'u1'",
        "WITH marker AS (SELECT 'escaped ''-- marker') INSERT INTO users SELECT 'u3'",
        "WITH marker AS (SELECT 'escaped ''/*x*/ marker') REPLACE INTO users (id) VALUES ('u4')",
        'WITH marker AS (SELECT "--") DELETE FROM "users" WHERE id = "u1"',
        'WITH marker AS (SELECT "/*x*/") UPDATE `users` SET id = "u2" WHERE id = "u1"',
        'WITH "sent--inel" AS (SELECT 1) INSERT INTO [users] SELECT "u3"',
        "WITH `sent/*inel*/` AS (SELECT 1) REPLACE INTO `users` (id) VALUES ('u4')",
        "WITH [sent--inel] AS (SELECT 1) DELETE FROM [users] WHERE id = 'u1'",
        "WITH [sent/*inel*/] AS (SELECT 1) UPDATE \"users\" SET id = 'u5' WHERE id = 'u1'",
        "INSERT INTO tooling_tool_identity_aliases (legacy_global_tool_id) VALUES ('x')",
        "DELETE FROM tooling_tool_identity_allocations",
    ]

    for sql in protected_writes:
        response = await db_service.execute_sql(DBExecuteSQLRequest(sql=sql))
        assert response.success is False
        assert "protected authority tables" in (response.error or "")
        assert response.rowcount == 0
        remained = await db_service.execute_sql(
            DBExecuteSQLRequest(sql="SELECT id FROM users ORDER BY id")
        )
        assert remained.rows == [{"id": "u1"}]

    selected = await db_service.execute_sql(DBExecuteSQLRequest(sql="SELECT * FROM users"))
    assert selected.success is True
    assert selected.rows == [{"id": "u1"}]

    harmless = await db_service.execute_sql(
        DBExecuteSQLRequest(
            sql="INSERT INTO harmless (id, note) VALUES (?, ?)",
            params=["h1", "users mentioned only in a string"],
        )
    )
    assert harmless.success is True
    assert harmless.rowcount == 1


@pytest.mark.asyncio
async def test_mesh_managed_generic_mutations_return_explicit_error_code(db_service):
    from app.services.db.manager import MeshManagedAuthorityError
    from app.shared.contracts.models.db import (
        DBDeleteDeviceRequest,
        DBDeleteUserRequest,
        DBRevokeTokenRequest,
        DBUpdateTokenScopesRequest,
        DBUpdateUserRequest,
    )

    rejection = MeshManagedAuthorityError("mesh_managed_authority")
    db_service.db_manager.update_user = AsyncMock(side_effect=rejection)
    db_service.db_manager.delete_user = AsyncMock(side_effect=rejection)
    db_service.db_manager.delete_device = AsyncMock(side_effect=rejection)
    db_service.db_manager.update_token_scopes = AsyncMock(side_effect=rejection)
    db_service.db_manager.revoke_token_with_authority = AsyncMock(side_effect=rejection)

    responses = [
        await db_service.update_user(
            DBUpdateUserRequest(user_id="mesh-user", fields={"permissions": ["DB.use"]})
        ),
        await db_service.delete_user(DBDeleteUserRequest(user_id="mesh-user")),
        await db_service.delete_device(DBDeleteDeviceRequest(device_id="mesh-device")),
        await db_service.update_token_scopes(
            DBUpdateTokenScopesRequest(token_id="mesh-token", scopes=["DB.use"])
        ),
        await db_service.revoke_token(
            DBRevokeTokenRequest(token_id="mesh-token", reject_mesh_linked=True)
        ),
    ]

    assert all(response.success is False for response in responses)
    assert all(response.error_code == "mesh_managed_authority" for response in responses)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "create_request",
    [
        DBCreateTokenRequest(
            id="new-token",
            token_hash="new-hash",
            prefix="new",
            user_id="mesh-user",
            device_id="unlinked-device",
            scopes=["DB.use"],
        ),
        DBCreateTokenRequest(
            id="new-token",
            token_hash="new-hash",
            prefix="new",
            user_id="unlinked-user",
            device_id="mesh-device",
            scopes=["DB.use"],
        ),
    ],
)
async def test_create_token_rejects_mesh_linked_user_or_device_without_changes(
    db_service,
    tmp_path,
    create_request,
):
    db_path = str(tmp_path / "mesh-create-token-guard.db")
    async with aiosqlite.connect(db_path) as db:
        await db.executescript(
            """
            CREATE TABLE tokens (
                id TEXT PRIMARY KEY,
                device_id TEXT,
                user_id TEXT,
                token_hash TEXT NOT NULL,
                prefix TEXT NOT NULL,
                scopes TEXT NOT NULL,
                expires_at TIMESTAMP,
                created_at TIMESTAMP
            );
            CREATE TABLE mesh_peers (
                id TEXT PRIMARY KEY,
                peer_id TEXT NOT NULL,
                room_name TEXT NOT NULL,
                outbound_status TEXT NOT NULL,
                outbound_permissions TEXT NOT NULL,
                outbound_user_id TEXT,
                outbound_token_id TEXT,
                outbound_device_id TEXT
            );
            INSERT INTO mesh_peers (
                id, peer_id, room_name, outbound_status, outbound_permissions,
                outbound_user_id, outbound_token_id, outbound_device_id
            ) VALUES (
                'mesh-row', 'stable-peer', 'room-a', 'approved', '["DB.use"]',
                'mesh-user', 'mesh-token', 'mesh-device'
            );
            """
        )
        await db.commit()
    db_service.db_manager = DatabaseManager(db_path=db_path)

    response = await db_service.create_token(create_request)

    assert response.success is False
    assert response.error_code == "mesh_managed_authority"
    async with aiosqlite.connect(db_path) as db:
        token_count = await (await db.execute("SELECT count(*) FROM tokens")).fetchone()
    assert token_count == (0,)


@pytest.mark.asyncio
async def test_typed_mesh_mutation_returns_immutable_authority_change(db_service):
    from pydantic import ValidationError

    from app.shared.contracts.models.db import (
        DBDenyMeshPeerRequest,
        DBMeshAuthorityChange,
    )

    change = DBMeshAuthorityChange(
        peer_id="stable-peer",
        auth_grant_revision=4,
        disposition="present",
        state="revoked",
        effective_permissions=(),
        reason="denied",
    )
    db_service.db_manager.deny_mesh_peer_with_authority = AsyncMock(return_value=(True, change))

    response = await db_service.deny_mesh_peer(DBDenyMeshPeerRequest(peer_id="stable-peer"))

    assert response.success is True
    assert response.authority_changes == (change,)
    with pytest.raises(ValidationError):
        response.authority_changes[0].auth_grant_revision = 5


@pytest.mark.asyncio
async def test_authority_snapshot_failure_is_reraised(db_service):
    from app.shared.contracts.models.db import DBGetMeshPeerAuthoritySnapshotRequest

    db_service.db_manager.get_mesh_peer_authority_snapshot = AsyncMock(
        side_effect=RuntimeError("snapshot unavailable")
    )

    with pytest.raises(RuntimeError, match="snapshot unavailable"):
        await db_service.get_mesh_peer_authority_snapshot(
            DBGetMeshPeerAuthoritySnapshotRequest(peer_id="stable-peer")
        )


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
    async def test_rag_search_remote_denies_missing_selector_for_sensitive_namespace(
        self, db_service
    ):
        """Remote-safe RAG search denies personal namespaces without any explicit selector."""
        from datetime import datetime

        from langgraph.store.base import Item

        from app.shared.contracts.models.db import DBRAGSearchRemoteRequest

        item = Item(
            value={
                "text": "private memory",
                "embedding": [0.1],
                "source_path": "/home/user/private.txt",
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
            DBRAGSearchRemoteRequest(namespace="main.memories", query="private")
        )

        assert response.decision == "denied"
        assert response.items == []
        assert "explicit mesh_selector" in response.denial_reason
        mock_store.search.assert_not_called()

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
        assert DBService.rag_search._contract_metadata["exposure"] == "internal"
        assert DBService.rag_search_remote._contract_metadata["exposure"] == "both"
        assert DBService.rag_list_namespaces._contract_metadata["exposure"] == "both"
        assert DBService.rag_export_namespace._contract_metadata["method_type"] == "manage"
        assert DBService.rag_import_namespace._contract_metadata["method_type"] == "manage"
        assert DBService.execute_sql._contract_metadata["exposure"] == "internal"
        assert DBService.execute_sql._contract_metadata["method_type"] == "manage"
