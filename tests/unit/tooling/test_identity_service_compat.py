"""Service-level durable Tooling identity compatibility regressions."""

from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from app.messaging import QueryResult
from app.services.db.manager import DatabaseManager
from app.services.db.sqlite_connection import SQLITE_CONNECT_TIMEOUT_SECONDS
from app.services.tooling.service import (
    TOOLING_DB_REQUEST_TIMEOUT_SECONDS,
    ToolingService,
)
from app.services.tooling.tools_manager import ToolsManager
from app.shared.contracts.models.db import DBAllocateToolIdentityRequest, DBMethods
from app.shared.contracts.models.tooling import (
    ToolingExecuteToolRequest,
    ToolingPolicyDecision,
    ToolingPrepareExecutionResponse,
    ToolingSharingPolicy,
    ToolingSharingPolicyRule,
)


class _IdentityBus:
    def __init__(self, manager: DatabaseManager):
        self.manager = manager
        self.requests: list[tuple[str, dict[str, object]]] = []

    async def request(self, topic, payload, **kwargs):
        self.requests.append((topic, kwargs))
        if topic == DBMethods.ALLOCATE_TOOL_IDENTITY:
            response = await self.manager.allocate_tool_identity(payload)
        elif topic == DBMethods.RECONCILE_TOOL_IDENTITY:
            response = await self.manager.reconcile_tool_identity(payload)
        elif topic == DBMethods.RESOLVE_TOOL_IDENTITY_ALIASES:
            response = await self.manager.resolve_tool_identity_aliases(
                payload.global_tool_ids, stable_peer_id=payload.stable_peer_id
            )
        else:
            return QueryResult(ok=False, error=f"unexpected topic {topic}")
        return QueryResult(ok=True, data=response)

    async def publish(self, *_args, **_kwargs):
        return None


class _NameOnlyPluginTool:
    __module__ = "community.calendar.tool"

    def __init__(self, name: str):
        self.name = name
        self.description = "Create a calendar event"
        self.args_schema = {
            "type": "object",
            "properties": {"title": {"type": "string"}},
        }
        self._aurora_loader_source = "plugin"
        self._aurora_plugin_id = "calendar"


class _TestToolingService(ToolingService):
    def __init__(self, bus: _IdentityBus):
        self._test_bus = bus
        super().__init__()

    @property
    def bus(self):
        return self._test_bus


async def _service(bus: _IdentityBus, tool: _NameOnlyPluginTool) -> ToolingService:
    service = _TestToolingService(bus)
    service.tools_manager = ToolsManager(bus)  # type: ignore[arg-type]
    service.tools_manager.tools = [tool]
    service.tools_manager._initialized = True
    service._stable_peer_id = "peer-stable-a"
    service._config.aupdate_config = AsyncMock(return_value=True)
    return service


@pytest.mark.asyncio
async def test_name_only_tool_rename_reuses_identity_resolves_alias_and_migrates_deny(
    tmp_path: Path,
):
    db = DatabaseManager(str(tmp_path / "identity-compat.db"))
    await db.initialize()
    bus = _IdentityBus(db)

    old_tool = _NameOnlyPluginTool("create_event")
    before = await _service(bus, old_tool)
    legacy_id = before._global_tool_id("local", "local:Tooling", old_tool.name)
    before._sharing_policy = ToolingSharingPolicy(
        default_share=True,
        rules=[
            ToolingSharingPolicyRule(
                rule_id="deny-old-id",
                global_tool_id=legacy_id,
                share=False,
                approval_mode="deny_all",
            ),
            ToolingSharingPolicyRule(
                rule_id="deny-remote-same-alias",
                provider_peer_id="remote-peer",
                global_tool_id=legacy_id,
                share=False,
                approval_mode="deny_all",
            ),
        ],
    )
    remote = await db.allocate_tool_identity(
        DBAllocateToolIdentityRequest(
            stable_peer_id="remote-peer",
            legacy_identity_locator="remote:legacy:create-event",
            source_kind="mesh_peer",
            stable_source_id="remote-peer",
            provider_tool_id="create-event",
            share_group_id="mesh:remote-peer:legacy",
            share_group_label="Peer tools",
            current_local_name="create_event",
            legacy_global_tool_ids=[legacy_id],
        )
    )
    assert remote.success is True
    await before._reconcile_local_tool_identities()
    original_identity = old_tool._aurora_tool_identity
    migrated_rule = before._sharing_policy.rules[0]
    assert migrated_rule.global_tool_id.startswith("aurora-tool:v1:peer-stable-a:Tooling:legacy.")
    assert migrated_rule.share is False
    migrated_remote_rule = before._sharing_policy.rules[1]
    assert migrated_remote_rule.global_tool_id == remote.canonical_global_tool_id
    assert migrated_remote_rule.global_tool_id != migrated_rule.global_tool_id

    renamed_tool = _NameOnlyPluginTool("create_calendar_event")
    after = await _service(bus, renamed_tool)
    await after._reconcile_local_tool_identities()

    assert renamed_tool._aurora_tool_identity.tool_contract_id == original_identity.tool_contract_id
    resolved_name = await after._resolve_tool_name(
        ToolingExecuteToolRequest(tool_name=legacy_id, arguments={"title": "Review"})
    )
    assert resolved_name == "create_calendar_event"
    prepared = ToolingPrepareExecutionResponse(
        ok=True,
        policy_decision=ToolingPolicyDecision(
            allowed=True,
            share=True,
            approval_required=False,
            approval_mode="approve_all_local_safe",
            decision_id="local-stable-peer",
        ),
        args_hash="args",
        resource_selector_hash="resource",
        route_decision_id="route",
        correlation_id="correlation",
        provider_peer_id="peer-stable-a",
        provider_service_instance_id="local:Tooling",
        global_tool_id=migrated_rule.global_tool_id,
        local_tool_name="create_calendar_event",
        source="plugin",
        source_id=None,
    )
    assert after._source_id_for_prepared(prepared) == "local:plugin"


@pytest.mark.asyncio
async def test_name_only_same_named_mcp_tools_use_server_scoped_allocations(tmp_path: Path):
    db = DatabaseManager(str(tmp_path / "mcp-scoped-identities.db"))
    await db.initialize()
    bus = _IdentityBus(db)
    service = _TestToolingService(bus)
    service.tools_manager = ToolsManager(bus)  # type: ignore[arg-type]
    mail = _NameOnlyPluginTool("search")
    calendar = _NameOnlyPluginTool("search")
    for tool, server_id in ((mail, "mail"), (calendar, "calendar")):
        tool._aurora_loader_source = "mcp"
        tool._aurora_mcp_server_id = server_id
        tool._aurora_stable_source_id = server_id
    service.tools_manager.tools = [mail, calendar]
    service.tools_manager._initialized = True
    service._stable_peer_id = "peer-stable-a"
    service._config.aupdate_config = AsyncMock(return_value=True)

    await service._reconcile_local_tool_identities()

    assert mail._aurora_tool_identity.stable_source_id == "mail"
    assert calendar._aurora_tool_identity.stable_source_id == "calendar"
    assert (
        mail._aurora_tool_identity.tool_contract_id
        != calendar._aurora_tool_identity.tool_contract_id
    )
    assert mail._aurora_tool_identity.share_group_id == "mcp:mail"
    assert calendar._aurora_tool_identity.share_group_id == "mcp:calendar"


@pytest.mark.asyncio
async def test_identity_requests_outlive_sqlite_lock_wait_budget(tmp_path: Path):
    """Tooling must not abandon a DB write while SQLite can still acquire its lock."""

    db = DatabaseManager(str(tmp_path / "identity-timeout.db"))
    await db.initialize()
    bus = _IdentityBus(db)
    service = await _service(bus, _NameOnlyPluginTool("create_event"))

    await service._reconcile_local_tool_identities()

    identity_topics = {
        DBMethods.ALLOCATE_TOOL_IDENTITY,
        DBMethods.RECONCILE_TOOL_IDENTITY,
    }
    identity_requests = [kwargs for topic, kwargs in bus.requests if topic in identity_topics]
    assert identity_requests
    assert TOOLING_DB_REQUEST_TIMEOUT_SECONDS > SQLITE_CONNECT_TIMEOUT_SECONDS
    assert all(
        kwargs["timeout"] == TOOLING_DB_REQUEST_TIMEOUT_SECONDS for kwargs in identity_requests
    )
