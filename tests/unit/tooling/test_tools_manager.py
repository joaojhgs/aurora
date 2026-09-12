"""Unit tests for ToolsManager lookup and RAG sync behavior."""

from unittest.mock import AsyncMock, Mock, patch

import pytest

from app.messaging import QueryResult
from app.messaging.priority_helpers import get_system_priority
from app.services.tooling.identity import (
    ToolIdentityCollisionError,
    source_tool_identity,
    stamp_tool,
)
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


def test_same_named_distinct_source_tools_remain_in_inventory_and_name_lookup_fails_closed():
    manager = ToolsManager(Mock())
    mail = _Tool("search", "Mail search")
    calendar = _Tool("search", "Calendar search")
    stamp_tool(
        mail,
        source_tool_identity(
            source_kind="mcp",
            stable_source_id="mail",
            provider_tool_id="search",
            share_group_id="mcp:mail",
            share_group_label="Mail",
        ),
    )
    stamp_tool(
        calendar,
        source_tool_identity(
            source_kind="mcp",
            stable_source_id="calendar",
            provider_tool_id="search",
            share_group_id="mcp:calendar",
            share_group_label="Calendar",
        ),
    )
    manager.tools = [mail, calendar]

    assert manager.get_tool_by_name("search") is None
    assert manager.tools == [mail, calendar]
    assert manager.ambiguous_tool_names == {"search"}
    assert set(manager.tool_identity_lookup) == {
        "mcp:mail:search",
        "mcp:calendar:search",
    }


def test_duplicate_contract_identity_fails_without_partial_lookup_replacement():
    manager = ToolsManager(Mock())
    first = _Tool("first", "First")
    second = _Tool("second", "Second")
    identity = source_tool_identity(
        source_kind="plugin",
        stable_source_id="mail",
        provider_tool_id="send",
        share_group_id="plugin:mail",
        share_group_label="Mail",
    )
    stamp_tool(first, identity)
    stamp_tool(second, identity)
    manager.tools = [first, second]

    with pytest.raises(ToolIdentityCollisionError, match="duplicate tool contract identity"):
        manager.get_all_tool_names()
    assert manager.tool_lookup == {}
    assert manager.tool_identity_lookup == {}


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


@pytest.mark.asyncio
async def test_reload_plugin_tools_replaces_only_plugin_config_phase_tools():
    """Plugin reload preserves core/MCP tools and tracks its replacement set."""
    manager = ToolsManager(Mock())
    core_tool = _Tool("core_tool", "Core")
    old_plugin_tool = _Tool("old_plugin_tool", "Old plugin")
    mcp_tool = _Tool("mcp_tool", "MCP")
    replacement_tool = _Tool("replacement_tool", "New plugin")
    manager.tools = [core_tool, old_plugin_tool, mcp_tool]
    manager.tool_lookup = {tool.name: tool for tool in manager.tools}
    manager._plugin_tools = [old_plugin_tool]

    async def load_replacement() -> None:
        manager.tools.append(replacement_tool)

    manager._load_plugin_tools = AsyncMock(side_effect=load_replacement)
    manager._sync_tools_with_database = AsyncMock()

    await manager.reload_plugin_tools()

    assert manager.tools == [core_tool, mcp_tool, replacement_tool]
    assert manager._plugin_tools == [replacement_tool]
    assert "old_plugin_tool" not in manager.tool_lookup
    manager._load_plugin_tools.assert_awaited_once_with()
    manager._sync_tools_with_database.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_mcp_reload_removes_owned_objects_not_same_named_core_tool():
    manager = ToolsManager(Mock())
    core = _Tool("search", "Core search")
    mcp = _Tool("search", "MCP search")
    stamp_tool(
        mcp,
        source_tool_identity(
            source_kind="mcp",
            stable_source_id="mail",
            provider_tool_id="search",
            share_group_id="mcp:mail",
            share_group_label="Mail",
        ),
    )
    manager.tools = [core, mcp]
    manager._mcp_tools_loaded = True
    manager._load_mcp_tools = AsyncMock()
    manager._sync_tools_with_database = AsyncMock()
    client = Mock()
    client.is_initialized = True
    client.get_tools.return_value = [mcp]
    client.close = AsyncMock()

    with patch("app.services.tooling.mcp.mcp_client.mcp_client_manager", client):
        await manager.reload_mcp_tools()

    assert manager.tools == [core]
    assert manager.get_tool_by_name("search") is core
    client.close.assert_awaited_once_with()
