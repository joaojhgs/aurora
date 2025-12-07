"""Unit tests for DBService."""

from unittest.mock import AsyncMock, MagicMock, Mock, patch

import pytest

from app.db.service import (
    DBService,
    GetMessagesForDate,
    GetRecentMessages,
    RAGDeleteCommand,
    RAGGetQuery,
    RAGListQuery,
    RAGSearchQuery,
    RAGStoreCommand,
    StoreMessage,
)
from app.messaging import DBTopics, Envelope, MessageBus, QueryResult


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
        patch("app.db.service.DatabaseManager") as mock_db_mgr,
        patch("app.db.service.SchedulerDatabaseService") as mock_scheduler_db,
        patch("app.db.service.RAGService") as mock_rag,
    ):
        mock_db_mgr.return_value.initialize = AsyncMock()
        mock_scheduler_db.return_value.initialize = AsyncMock()
        mock_rag.return_value.combined_store = MagicMock()

        service = DBService(bus=mock_bus)
        service.db_manager = mock_db_mgr.return_value
        service.scheduler_db = mock_scheduler_db.return_value
        service.rag_service = mock_rag.return_value
        return service


class TestDBServiceInitialization:
    """Test DBService initialization."""

    def test_init(self, mock_bus):
        """Test service initialization."""
        with (
            patch("app.db.service.DatabaseManager"),
            patch("app.db.service.SchedulerDatabaseService"),
            patch("app.db.service.RAGService"),
        ):
            service = DBService(bus=mock_bus)
            assert service.bus == mock_bus

    @pytest.mark.asyncio
    async def test_start(self, db_service, mock_bus):
        """Test service start."""
        await db_service.start()

        # Verify subscriptions were made
        assert mock_bus.subscribe.call_count >= 11  # Database + RAG topics

        # Verify correct topics subscribed
        subscribed_topics = [call[0][0] for call in mock_bus.subscribe.call_args_list]
        assert DBTopics.STORE_MESSAGE in subscribed_topics
        assert DBTopics.GET_RECENT_MESSAGES in subscribed_topics
        assert DBTopics.RAG_STORE in subscribed_topics
        assert DBTopics.RAG_SEARCH in subscribed_topics

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
        cmd = StoreMessage(role="user", content="Hello", session_id="test-session")
        env = Envelope(type=DBTopics.STORE_MESSAGE, payload=cmd)

        db_service.db_manager.store_message = AsyncMock(return_value=True)

        await db_service._store_message(env)

        db_service.db_manager.store_message.assert_called_once()

    @pytest.mark.asyncio
    async def test_get_messages(self, db_service, mock_bus):
        """Test get recent messages query."""
        query = GetRecentMessages(limit=10)
        env = Envelope(type=DBTopics.GET_RECENT_MESSAGES, payload=query, reply_to="test.reply")

        mock_messages = [
            MagicMock(role="user", content="Hello", timestamp="2024-01-01", metadata={}),
            MagicMock(role="assistant", content="Hi", timestamp="2024-01-01", metadata={}),
        ]
        db_service.db_manager.get_recent_messages = AsyncMock(return_value=mock_messages)

        await db_service._get_messages(env)

        # Verify response was published
        mock_bus.publish.assert_called_once()
        call_args = mock_bus.publish.call_args
        assert call_args[0][0] == "test.reply"
        assert isinstance(call_args[0][1], QueryResult)

    @pytest.mark.asyncio
    async def test_get_messages_for_date(self, db_service, mock_bus):
        """Test get messages for date query."""
        query = GetMessagesForDate(date="2024-01-01")
        env = Envelope(type=DBTopics.GET_MESSAGES_FOR_DATE, payload=query)

        mock_messages = [MagicMock(role="user", content="Test", timestamp=None, metadata={})]
        db_service.db_manager.get_messages_for_date = AsyncMock(return_value=mock_messages)

        await db_service._get_messages_for_date(env)

        # Verify event was published
        mock_bus.publish.assert_called_once()


class TestDBServiceRAGOperations:
    """Test DBService RAG operations."""

    @pytest.mark.asyncio
    async def test_rag_store(self, db_service):
        """Test RAG store command."""
        cmd = RAGStoreCommand(
            namespace=("main", "memories"), key="test-key", value={"text": "Test memory"}
        )
        env = Envelope(type=DBTopics.RAG_STORE, payload=cmd)

        mock_store = MagicMock()
        mock_store.put = Mock()
        db_service.rag_service.combined_store = mock_store

        await db_service._rag_store(env)

        mock_store.put.assert_called_once_with(
            ("main", "memories"), "test-key", {"text": "Test memory"}, None
        )

    @pytest.mark.asyncio
    async def test_rag_delete(self, db_service):
        """Test RAG delete command."""
        cmd = RAGDeleteCommand(namespace=("main", "memories"), key="test-key")
        env = Envelope(type=DBTopics.RAG_DELETE, payload=cmd)

        mock_store = MagicMock()
        mock_store.delete = Mock()
        db_service.rag_service.combined_store = mock_store

        await db_service._rag_delete(env)

        mock_store.delete.assert_called_once_with(("main", "memories"), "test-key")

    @pytest.mark.asyncio
    async def test_rag_search(self, db_service, mock_bus):
        """Test RAG search query."""
        query = RAGSearchQuery(namespace=("main", "memories"), query="test query", limit=5)
        env = Envelope(type=DBTopics.RAG_SEARCH, payload=query, reply_to="test.reply")

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

        await db_service._rag_search(env)

        # Verify response was published
        mock_bus.publish.assert_called_once()
        call_args = mock_bus.publish.call_args
        assert call_args[0][0] == "test.reply"
        result = call_args[0][1]
        assert isinstance(result, QueryResult)
        assert result.ok is True
        assert "items" in result.data

    @pytest.mark.asyncio
    async def test_rag_get(self, db_service, mock_bus):
        """Test RAG get query."""
        query = RAGGetQuery(namespace=("main", "memories"), key="test-key")
        env = Envelope(type=DBTopics.RAG_GET, payload=query, reply_to="test.reply")

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

        await db_service._rag_get(env)

        # Verify response was published
        mock_bus.publish.assert_called_once()
        call_args = mock_bus.publish.call_args
        result = call_args[0][1]
        assert isinstance(result, QueryResult)
        assert result.ok is True
        assert result.data["key"] == "test-key"

    @pytest.mark.asyncio
    async def test_rag_get_not_found(self, db_service, mock_bus):
        """Test RAG get query when item not found."""
        query = RAGGetQuery(namespace=("main", "memories"), key="non-existent")
        env = Envelope(type=DBTopics.RAG_GET, payload=query, reply_to="test.reply")

        mock_store = MagicMock()
        mock_store.get = Mock(return_value=None)
        db_service.rag_service.combined_store = mock_store

        await db_service._rag_get(env)

        # Verify error response was published
        mock_bus.publish.assert_called_once()
        call_args = mock_bus.publish.call_args
        result = call_args[0][1]
        assert isinstance(result, QueryResult)
        assert result.ok is False

    @pytest.mark.asyncio
    async def test_rag_list(self, db_service, mock_bus):
        """Test RAG list query."""
        query = RAGListQuery(namespace=("tools",), limit=10, offset=0)
        env = Envelope(type=DBTopics.RAG_LIST, payload=query, reply_to="test.reply")

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

        await db_service._rag_list(env)

        # Verify response was published
        mock_bus.publish.assert_called_once()
        call_args = mock_bus.publish.call_args
        result = call_args[0][1]
        assert isinstance(result, QueryResult)
        assert result.ok is True
        assert "items" in result.data
