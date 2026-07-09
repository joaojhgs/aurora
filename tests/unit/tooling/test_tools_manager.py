"""Unit tests for ToolsManager lookup and RAG sync behavior."""

from unittest.mock import AsyncMock, Mock

import pytest

from app.messaging import QueryResult
from app.messaging.priority_helpers import get_system_priority
from app.services.tooling.tools_manager import ToolsManager
from app.shared.contracts.models.db import (
    DBMethods,
    DBRAGDeleteRequest,
    DBRAGListRequest,
    DBRAGStoreRequest,
)


class _Tool:
    def __init__(self, name: str, description: str) -> None:
        self.name = name
        self.description = description


def test_lookup_rebuilds_when_empty_or_stale():
    """Name lookup mirrors the loaded tools even if the cache is empty or stale."""

    manager = ToolsManager(Mock())
    first = _Tool("first_tool", "First tool")
    second = _Tool("second_tool", "Second tool")
    manager.tools = [first]

    assert manager.get_tool_by_name("first_tool") is first
    assert manager.get_all_tool_names() == ["first_tool"]

    manager.tools = [second]

    assert manager.get_tool_by_name("first_tool") is None
    assert manager.get_tool_by_name("second_tool") is second
    assert manager.get_all_tool_names() == ["second_tool"]


@pytest.mark.asyncio
async def test_sync_tools_with_database_uses_bounded_requests_for_mutations():
    """RAG store/delete sync uses request/response calls instead of fire-and-forget publish."""

    bus = Mock()
    bus.publish = AsyncMock()
    bus.request = AsyncMock(
        side_effect=[
            QueryResult(
                ok=True,
                data={
                    "items": [
                        {
                            "key": "changed_tool",
                            "value": {"name": "changed_tool", "description": "old"},
                        },
                        {
                            "key": "stale_tool",
                            "value": {"name": "stale_tool", "description": "gone"},
                        },
                    ]
                },
            ),
            QueryResult(ok=True, data={}),
            QueryResult(ok=True, data={}),
            QueryResult(ok=True, data={}),
        ]
    )
    manager = ToolsManager(bus)
    manager.tools = [
        _Tool("changed_tool", "new"),
        _Tool("new_tool", "brand new"),
    ]

    await manager._sync_tools_with_database()

    assert bus.publish.await_count == 0
    assert [call.args[0] for call in bus.request.await_args_list] == [
        DBMethods.RAG_LIST,
        DBMethods.RAG_STORE,
        DBMethods.RAG_STORE,
        DBMethods.RAG_DELETE,
    ]
    list_call = bus.request.await_args_list[0]
    assert isinstance(list_call.args[1], DBRAGListRequest)
    assert list_call.kwargs["timeout"] == 5.0
    assert list_call.kwargs["priority"] == get_system_priority()

    mutation_calls = bus.request.await_args_list[1:]
    assert all(call.kwargs["timeout"] == 2.0 for call in mutation_calls)
    assert all(call.kwargs["priority"] == get_system_priority() for call in mutation_calls)
    assert all(
        isinstance(call.args[1], DBRAGStoreRequest | DBRAGDeleteRequest) for call in mutation_calls
    )
    assert manager.get_tool_by_name("new_tool") is manager.tools[1]


@pytest.mark.asyncio
async def test_sync_tools_with_database_skips_mutations_when_list_shape_invalid():
    """Tools are not added/deleted when the authoritative RAG list cannot be read."""

    bus = Mock()
    bus.publish = AsyncMock()
    bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"unexpected": []}))
    manager = ToolsManager(bus)
    manager.tools = [_Tool("new_tool", "brand new")]

    await manager._sync_tools_with_database()

    bus.request.assert_awaited_once()
    assert bus.request.await_args.args[0] == DBMethods.RAG_LIST
    assert bus.publish.await_count == 0
