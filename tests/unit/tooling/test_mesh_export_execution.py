"""Hostile recipient-projection and execution-order tests for G013."""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from langchain_core.tools import tool

from app.messaging import Envelope, QueryResult
from app.services.tooling.identity import source_tool_identity, stamp_tool
from app.services.tooling.projection_cursor import ProjectionCursor
from app.services.tooling.service import _derive_js_safe_catalog_revision
from app.shared.contracts.models.db import (
    DBGetToolingExportPolicySnapshotResponse,
    DBGetToolingExposureLedgerResponse,
    DBMethods,
    DBRecordToolingExposuresResponse,
    DBToolingExposureLedgerEntry,
)
from app.shared.contracts.models.gateway import GatewayFetchToolingExportCatalogPageResponse
from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.models.tooling import (
    JS_SAFE_INTEGER_MAX,
    ToolingExecuteToolRequest,
    ToolingExportPolicy,
    ToolingGetExportCatalogRequest,
    ToolingGetExportCatalogResponse,
    ToolingGetToolByNameRequest,
    ToolingGetToolExportPolicyRequest,
    ToolingGetToolsRequest,
    ToolingMeshKillSwitches,
    ToolingMethods,
    ToolingPrepareExecutionRequest,
    ToolingProjectionAuthorityRevision,
    ToolingProjectionSyncRequested,
    ToolingRequestApprovalRequest,
    ToolingSharingPolicy,
    ToolingSharingPolicyRule,
    ToolingToolInfo,
    ToolingToolProvenance,
)

pytest_plugins = ["tests.unit.tooling.test_service"]


@pytest.mark.asyncio
async def test_normalized_alias_rekeys_only_provider_policy_and_survives_reload(
    tooling_service,
):
    """A committed remote rename preserves Config-owned decisions by stable peer."""

    provider = "peer-renamed"
    other_provider = "peer-other"
    legacy_id = "legacy:shared-name"
    canonical_id = "aurora-tool:v1:peer-renamed:Tooling:calendar.list"
    tooling_service._sharing_policy = ToolingSharingPolicy(
        default_share=True,
        rules=[
            ToolingSharingPolicyRule(
                rule_id="deny-renamed",
                provider_peer_id=provider,
                global_tool_id=legacy_id,
                share=False,
                approval_mode="deny_all",
            ),
            ToolingSharingPolicyRule(
                rule_id="other-peer-unchanged",
                provider_peer_id=other_provider,
                global_tool_id=legacy_id,
                share=True,
                approval_mode="ask_each_time",
            ),
        ],
    )
    persisted: dict[str, object] = {}

    async def resolve_alias(method, payload, **_kwargs):
        assert method == DBMethods.RESOLVE_TOOLING_REMOTE_TOOL_ALIASES
        assert payload.peer_id == provider
        assert payload.provider_id == provider
        assert payload.global_tool_ids == [legacy_id]
        return QueryResult(
            ok=True,
            data={"canonical_by_requested_id": {legacy_id: canonical_id}},
        )

    async def persist(path, value, **_kwargs):
        persisted[path] = value
        return True

    tooling_service.bus.request = AsyncMock(side_effect=resolve_alias)
    tooling_service._config.aupdate_config = AsyncMock(side_effect=persist)
    await tooling_service._migrate_remote_policy_rule_tool_ids(provider)

    migrated, unrelated = tooling_service._sharing_policy.rules
    assert migrated.global_tool_id == canonical_id
    assert migrated.share is False
    assert migrated.approval_mode == "deny_all"
    assert unrelated.global_tool_id == legacy_id

    # Simulate a service restart reading the typed ConfigService value.
    tooling_service._sharing_policy = ToolingSharingPolicy()
    tooling_service._config.aget = AsyncMock(
        return_value=persisted["services.tooling.approval_policy"]
    )
    await tooling_service._load_sharing_policy_from_config()
    reloaded, reloaded_unrelated = tooling_service._sharing_policy.rules
    assert reloaded.global_tool_id == canonical_id
    assert reloaded.share is False
    assert reloaded.approval_mode == "deny_all"
    assert reloaded_unrelated.provider_peer_id == other_provider
    assert reloaded_unrelated.global_tool_id == legacy_id


@pytest.mark.asyncio
async def test_normalized_alias_persist_failure_duplicates_only_refusal(tooling_service):
    provider = "peer-fail-closed"
    tooling_service._sharing_policy = ToolingSharingPolicy(
        rules=[
            ToolingSharingPolicyRule(
                rule_id="deny",
                provider_peer_id=provider,
                global_tool_id="legacy:deny",
                share=False,
                approval_mode="deny_all",
            ),
            ToolingSharingPolicyRule(
                rule_id="allow",
                provider_peer_id=provider,
                global_tool_id="legacy:allow",
                share=True,
                approval_mode="approve_all_for_peer",
            ),
        ]
    )
    tooling_service.bus.request = AsyncMock(
        return_value=QueryResult(
            ok=True,
            data={
                "canonical_by_requested_id": {
                    "legacy:deny": "canonical:deny",
                    "legacy:allow": "canonical:allow",
                }
            },
        )
    )
    tooling_service._config.aupdate_config = AsyncMock(return_value=False)

    with pytest.raises(RuntimeError, match="alias migration was not persisted"):
        await tooling_service._migrate_remote_policy_rule_tool_ids(provider)

    selectors = {
        (rule.rule_id, rule.global_tool_id, rule.share, rule.approval_mode)
        for rule in tooling_service._sharing_policy.rules
    }
    assert ("deny", "legacy:deny", False, "deny_all") in selectors
    assert ("deny", "canonical:deny", False, "deny_all") in selectors
    assert ("allow", "legacy:allow", True, "approve_all_for_peer") in selectors
    assert not any(selector[1] == "canonical:allow" for selector in selectors)


@pytest.fixture
def export_service(tooling_service):
    @tool
    def alpha(value: str = "a") -> str:
        """First exported tool."""
        return value

    @tool
    def beta(value: str = "b") -> str:
        """Second exported tool."""
        return value

    for item in (alpha, beta):
        stamp_tool(
            item,
            source_tool_identity(
                source_kind="plugin",
                stable_source_id="hostile-suite",
                provider_tool_id=item.name,
                share_group_id="plugin:hostile-suite",
                share_group_label="Hostile suite",
            ),
        )
    tooling_service._stable_peer_id = "provider"
    tooling_service.tools_manager.get_tools = Mock(return_value=[alpha, beta])
    ledger: dict[tuple[str, str], dict[str, str | None]] = {}

    async def db_request(topic, payload, **_kwargs):
        key = (payload.recipient_peer_id, payload.provider_id)
        if topic == DBMethods.GET_TOOLING_EXPOSURE_LEDGER:
            return QueryResult(
                ok=True,
                data=DBGetToolingExposureLedgerResponse(
                    entries=[
                        DBToolingExposureLedgerEntry(
                            global_tool_id=global_id,
                            last_schema_hash=schema_hash,
                        )
                        for global_id, schema_hash in ledger.get(key, {}).items()
                    ]
                ).model_dump(),
            )
        if topic == DBMethods.RECORD_TOOLING_EXPOSURES:
            bucket = ledger.setdefault(key, {})
            for entry in payload.entries:
                bucket[entry.global_tool_id] = entry.last_schema_hash
            return QueryResult(
                ok=True,
                data=DBRecordToolingExposuresResponse(
                    recorded_count=len(payload.entries)
                ).model_dump(),
            )
        raise AssertionError(topic)

    tooling_service.bus.request = AsyncMock(side_effect=db_request)
    tooling_service._test_exposure_ledger = ledger
    state = {
        "policy_revision": 10,
        "switch_revision": 20,
        "provider_enabled": True,
    }

    async def snapshot(**_kwargs):
        return DBGetToolingExportPolicySnapshotResponse(
            policy=ToolingExportPolicy(
                default_state="shared",
                revision=state["policy_revision"],
                initialized=True,
            ),
            rules=[],
            mesh_switches=ToolingMeshKillSwitches(
                provider_mesh_tooling_enabled=state["provider_enabled"],
                revision=state["switch_revision"],
            ),
        )

    tooling_service._tool_export_snapshot = AsyncMock(side_effect=snapshot)
    return tooling_service, state, alpha, beta


def _authority_envelope(
    peer: str = "peer-a",
    *,
    auth_revision: int = 3,
    manifest_revision: int = 4,
) -> Envelope:
    topics = sorted(
        {
            ToolingMethods.GET_TOOLS,
            ToolingMethods.GET_TOOL_BY_NAME,
            ToolingMethods.GET_EXPORT_CATALOG,
            ToolingMethods.PREPARE_EXECUTION,
            ToolingMethods.EXECUTE_TOOL,
            ToolingMethods.REQUEST_APPROVAL,
        }
    )
    return Envelope(
        type=ToolingMethods.GET_EXPORT_CATALOG,
        payload={},
        origin="external",
        caller_peer_id=peer,
        effective_perms=["*"],
        auth_grant_revision=auth_revision,
        manifest_revision=manifest_revision,
        projected_service_id="Tooling",
        projected_method_id=ToolingMethods.GET_EXPORT_CATALOG,
        projected_method_topics=topics,
        projected_method_set_digest=hashlib.sha256(
            json.dumps(topics, separators=(",", ":")).encode()
        ).hexdigest(),
    )


def _execution_envelope(topic: str, peer: str = "peer-a") -> Envelope:
    envelope = _authority_envelope(peer)
    envelope.type = topic
    envelope.projected_method_id = topic
    return envelope


def test_catalog_revision_helper_is_js_safe_stable_and_material_sensitive():
    revision = _derive_js_safe_catalog_revision("same material")

    assert 0 <= revision <= JS_SAFE_INTEGER_MAX
    assert revision == _derive_js_safe_catalog_revision("same material")
    assert revision != _derive_js_safe_catalog_revision("different material")


@pytest.mark.asyncio
async def test_export_catalog_revision_is_safe_stable_and_catalog_sensitive(export_service):
    service, _state, _alpha, beta = export_service

    first = await service._on_get_export_catalog(
        ToolingGetExportCatalogRequest(),
        _authority_envelope(),
    )
    await service._announce_local_tool_catalog(reason="reload")
    invalidation = service.bus.publish.await_args.args[1]
    second = await service._on_get_export_catalog(
        ToolingGetExportCatalogRequest(),
        _authority_envelope(),
    )
    beta.description = "materially different beta catalog"
    changed = await service._on_get_export_catalog(
        ToolingGetExportCatalogRequest(),
        _authority_envelope(),
    )

    assert 0 <= first.authority_revision.catalog_revision <= JS_SAFE_INTEGER_MAX
    assert (
        invalidation.authority_revision.catalog_revision
        == first.authority_revision.catalog_revision
    )
    assert second.authority_revision.catalog_revision == first.authority_revision.catalog_revision
    assert changed.authority_revision.catalog_revision != first.authority_revision.catalog_revision


@pytest.mark.asyncio
async def test_export_cursor_all_authority_mutations_have_one_restart_failure(export_service):
    service, state, alpha, beta = export_service
    first = await service._on_get_export_catalog(
        ToolingGetExportCatalogRequest(page_size=1),
        _authority_envelope(),
    )
    assert first.next_cursor and not first.complete
    original_tools = [alpha, beta]
    original_beta_description = beta.description

    async def rejected(*, request=None, envelope=None, mutate=None):
        service.tools_manager.get_tools.return_value = list(original_tools)
        beta.description = original_beta_description
        state.update(policy_revision=10, switch_revision=20, provider_enabled=True)
        if mutate:
            mutate()
        with pytest.raises(PermissionError, match="^projection_restart_required$"):
            await service._on_get_export_catalog(
                request or ToolingGetExportCatalogRequest(page_size=1, cursor=first.next_cursor),
                envelope or _authority_envelope(),
            )

    await rejected(envelope=_authority_envelope("peer-b"))
    await rejected(mutate=lambda: setattr(beta, "description", "mutated catalog"))
    await rejected(mutate=lambda: state.update(policy_revision=11))
    await rejected(envelope=_authority_envelope(auth_revision=30))
    await rejected(envelope=_authority_envelope(manifest_revision=40))
    await rejected(mutate=lambda: state.update(switch_revision=21))
    await rejected(request=ToolingGetExportCatalogRequest(page_size=2, cursor=first.next_cursor))

    decoded = service._projection_cursor_codec.decode(first.next_cursor)
    expired = service._projection_cursor_codec.encode(
        ProjectionCursor(**{**decoded.__dict__, "expires_at": int(time.time()) - 1})
    )
    await rejected(request=ToolingGetExportCatalogRequest(page_size=1, cursor=expired))
    tampered = first.next_cursor[:-1] + ("A" if first.next_cursor[-1] != "A" else "B")
    await rejected(request=ToolingGetExportCatalogRequest(page_size=1, cursor=tampered))


@pytest.mark.asyncio
async def test_export_page_binds_local_tools_to_stable_mesh_service_instance(export_service):
    service, _state, _alpha, _beta = export_service

    page = await service._on_get_export_catalog(
        ToolingGetExportCatalogRequest(),
        _authority_envelope(),
    )

    expected_service = "remote:provider:Tooling"
    assert page.service_instance_id == expected_service
    assert page.tools
    assert all(tool.provider_peer_id == "provider" for tool in page.tools)
    assert all(tool.provider_service_instance_id == expected_service for tool in page.tools)
    assert all(tool.provenance.provider_peer_id == "provider" for tool in page.tools)
    assert all(
        tool.provenance.provider_service_instance_id == expected_service for tool in page.tools
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("service_id", "method_id"),
    [
        (None, None),
        ("TTS", ToolingMethods.GET_EXPORT_CATALOG),
        ("Tooling", ToolingMethods.GET_TOOLS),
    ],
)
async def test_export_requires_exact_authenticated_service_method_evidence(
    export_service, service_id, method_id
):
    service, *_ = export_service
    envelope = _authority_envelope()
    envelope.projected_service_id = service_id
    envelope.projected_method_id = method_id

    with pytest.raises(PermissionError, match="^projection_authority_unknown$"):
        await service._on_get_export_catalog(ToolingGetExportCatalogRequest(), envelope)


@pytest.mark.asyncio
async def test_provider_projection_keeps_permission_blocks_management_only_and_retires_other_losses(
    export_service,
):
    service, _state, alpha, _beta = export_service
    object.__setattr__(alpha, "required_permissions", ["Network.Use"])
    service.tools_manager.get_tools.return_value = [alpha]
    ledger = service._test_exposure_ledger
    first = await service._on_get_export_catalog(
        ToolingGetExportCatalogRequest(), _authority_envelope()
    )
    exposed_id = first.tools[0].global_tool_id
    assert ledger[("peer-a", "provider")].keys() == {exposed_id}

    permission_envelope = _authority_envelope()
    permission_envelope.effective_perms = [
        ToolingMethods.GET_TOOLS,
        ToolingMethods.EXECUTE_TOOL,
    ]
    permission_blocked = await service._on_get_export_catalog(
        ToolingGetExportCatalogRequest(), permission_envelope
    )
    assert permission_blocked.tools == []
    assert permission_blocked.retirements == []
    assert permission_blocked.blocked_tools[0].tool.global_tool_id == exposed_id
    assert permission_blocked.blocked_tools[0].reason_code == ("recipient_missing_tool_permissions")
    assert permission_blocked.blocked_tools[0].missing_permissions == ["Network.Use"]

    base_snapshot = await service._tool_export_snapshot(peer_id="peer-a")
    service._tool_export_snapshot = AsyncMock(
        return_value=base_snapshot.model_copy(
            update={"policy": base_snapshot.policy.model_copy(update={"default_state": "unshared"})}
        )
    )
    unshared = await service._on_get_export_catalog(
        ToolingGetExportCatalogRequest(), _authority_envelope()
    )
    assert unshared.retirements[0].availability == "unshared"
    assert unshared.retirements[0].reason_code == "provider_export_policy_unshared"

    service._tool_export_snapshot = AsyncMock(
        return_value=base_snapshot.model_copy(update={"stale_tool_ids": [exposed_id]})
    )
    stale = await service._on_get_export_catalog(
        ToolingGetExportCatalogRequest(), _authority_envelope()
    )
    assert stale.retirements[0].availability == "stale"
    assert stale.retirements[0].reason_code == "provider_tool_identity_stale"

    service._tool_export_snapshot = AsyncMock(return_value=base_snapshot)
    service.tools_manager.get_tools.return_value = []
    removed = await service._on_get_export_catalog(
        ToolingGetExportCatalogRequest(), _authority_envelope()
    )

    assert removed.tools == []
    assert [item.global_tool_id for item in removed.retirements] == [exposed_id]
    assert removed.retirements[0].availability == "removed"
    assert removed.retirements[0].reason_code == "provider_tool_removed"


@pytest.mark.asyncio
async def test_mixed_local_and_remote_catalog_never_reexports_remote_child(export_service):
    service, _state, alpha, _beta = export_service
    remote_loaded = Mock(name="remote-child")
    remote_loaded.name = "remote_child"
    remote_info = ToolingToolInfo(
        name="peer_remote_child",
        local_name="remote_child",
        global_tool_id="aurora-tool:v1:upstream:Tooling:remote_child",
        tool_id_scheme="aurora-tool",
        tool_id_version=1,
        tool_contract_id="remote_child",
        share_group_id="core:remote",
        share_group_label="Remote",
        provider_peer_id="upstream",
        provider_service_instance_id="remote:upstream:Tooling",
        namespace="upstream",
        display_name="Remote child",
        source_type="mesh_peer",
        source="mesh_peer",
        execution_location="remote",
        provenance=ToolingToolProvenance(
            provider_peer_id="upstream",
            provider_service_instance_id="remote:upstream:Tooling",
            provider_kind="mesh_peer",
            source="unknown",
            advertised_name="remote_child",
        ),
    )
    original_serialize = service._serialize_tool
    service.tools_manager.get_tools.return_value = [alpha, remote_loaded]
    service._serialize_tool = Mock(
        side_effect=lambda item, request: remote_info
        if item is remote_loaded
        else original_serialize(item, request)
    )

    response = await service._on_get_export_catalog(
        ToolingGetExportCatalogRequest(), _authority_envelope()
    )

    assert [tool.local_name for tool in response.tools] == ["alpha"]
    assert remote_info.global_tool_id not in response.model_dump_json()


@pytest.mark.asyncio
async def test_hidden_remote_denial_precedes_approval_token_grant_and_invocation(tooling_service):
    hidden = "secret_schema_alias"
    tool_double = Mock(name="hidden-tool")
    tool_double.name = hidden
    tool_double.ainvoke = AsyncMock(return_value="must-not-run")
    tooling_service.tools_manager.get_all_tool_names.return_value = [hidden]
    tooling_service.tools_manager.get_tool_by_name.return_value = tool_double
    tooling_service._mesh_projection_enforcement_active = True
    tooling_service._consumer_mesh_execution_authorized = AsyncMock(return_value=False)
    tooling_service._find_matching_grant = AsyncMock()
    tooling_service._load_approval_token = AsyncMock()
    tooling_service._mark_approval_token_used = AsyncMock()
    tooling_service._audit_tool_execution = AsyncMock()
    selector = MeshAddressSelector(peer_id="peer-b", service_instance_id="remote:peer-b:Tooling")

    prepared = await tooling_service._on_prepare_execution(
        ToolingPrepareExecutionRequest(tool_name=hidden, arguments={}, mesh_selector=selector)
    )
    executed = await tooling_service._on_execute_tool(
        ToolingExecuteToolRequest(
            tool_name=hidden,
            arguments={},
            mesh_selector=selector,
            approval_token="forged-token",
        )
    )

    serialized = f"{prepared.model_dump_json()} {executed.model_dump_json()}"
    assert hidden not in serialized and "schema" not in executed.error
    assert prepared.policy_decision.reason == "permission_denied"
    assert executed.error_code == "permission_denied"
    tooling_service._find_matching_grant.assert_not_awaited()
    tooling_service._load_approval_token.assert_not_awaited()
    tooling_service._mark_approval_token_used.assert_not_awaited()
    tooling_service._audit_tool_execution.assert_not_awaited()
    tool_double.ainvoke.assert_not_awaited()


@pytest.mark.asyncio
async def test_durable_cutover_retires_only_legacy_share_deny_for_projected_tool(
    export_service,
) -> None:
    service, _state, alpha, _beta = export_service
    service.tools_manager.get_tool_by_name.return_value = alpha
    service.tools_manager.get_all_tool_names.return_value = [alpha.name]
    service._sharing_policy = ToolingSharingPolicy(
        default_share=False,
        default_approval_mode="approve_all_local_safe",
    )
    request = ToolingPrepareExecutionRequest(tool_name=alpha.name, arguments={})

    service._mesh_projection_enforcement_active = False
    before = await service._on_prepare_execution(
        request.model_copy(deep=True),
        _execution_envelope(ToolingMethods.PREPARE_EXECUTION),
    )
    assert before.policy_decision.allowed is False
    assert before.policy_decision.reason == "tool_not_shared"
    executed_before = await service._on_execute_tool(
        ToolingExecuteToolRequest(tool_name=alpha.name, arguments={}, dry_run=True),
        _execution_envelope(ToolingMethods.EXECUTE_TOOL),
    )
    assert executed_before.ok is False
    assert executed_before.error_code == "tool_not_shared"

    service._mesh_projection_enforcement_active = True
    after = await service._on_prepare_execution(
        request.model_copy(deep=True),
        _execution_envelope(ToolingMethods.PREPARE_EXECUTION),
    )
    assert after.policy_decision.allowed is True
    assert after.policy_decision.reason != "tool_not_shared"
    executed_after = await service._on_execute_tool(
        ToolingExecuteToolRequest(tool_name=alpha.name, arguments={}, dry_run=True),
        _execution_envelope(ToolingMethods.EXECUTE_TOOL),
    )
    assert executed_after.ok is True
    assert executed_after.data and executed_after.data["dry_run"] is True


@pytest.mark.asyncio
async def test_active_remote_unknown_tool_denies_generically_before_resolution_or_audit(
    export_service,
) -> None:
    service, _state, _alpha, _beta = export_service
    service._mesh_projection_enforcement_active = True
    service.tools_manager.get_tools.return_value = []
    service.tools_manager.get_tool_by_name.reset_mock()
    service._audit_tooling_event = AsyncMock()

    response = await service._on_prepare_execution(
        ToolingPrepareExecutionRequest(tool_name="secret_unknown", arguments={}),
        _execution_envelope(ToolingMethods.PREPARE_EXECUTION),
    )

    assert response.ok is False
    assert response.policy_decision.reason == "permission_denied"
    assert response.global_tool_id == "" and response.local_tool_name == ""
    service.tools_manager.get_tool_by_name.assert_not_called()
    service._audit_tooling_event.assert_not_awaited()


@pytest.mark.asyncio
async def test_active_remote_approval_request_denies_before_resolution_without_exact_authority(
    export_service,
) -> None:
    service, _state, alpha, _beta = export_service
    service._mesh_projection_enforcement_active = True
    service.tools_manager.get_tool_by_name.reset_mock()
    service._audit_tooling_event = AsyncMock()
    envelope = _execution_envelope(ToolingMethods.PREPARE_EXECUTION)

    denied = await service._on_request_approval(
        ToolingRequestApprovalRequest(tool_name=alpha.name, arguments={}),
        envelope,
    )

    assert denied.ok is False and denied.error == "permission_denied"
    assert denied.policy_decision.reason == "permission_denied"
    service.tools_manager.get_tool_by_name.assert_not_called()
    service._audit_tooling_event.assert_not_awaited()


@pytest.mark.asyncio
async def test_hidden_remote_is_absent_from_list_search_exact_name_and_alias(tooling_service):
    peer_id = "peer-hidden"
    info = ToolingToolInfo(
        name="peer_hidden_secret",
        local_name="secret",
        global_tool_id="aurora-tool:v1:peer-hidden:Tooling:secret",
        tool_id_scheme="aurora-tool",
        tool_id_version=1,
        tool_contract_id="secret",
        share_group_id="core:hidden",
        share_group_label="Hidden",
        provider_peer_id=peer_id,
        provider_service_instance_id=f"remote:{peer_id}:Tooling",
        provider_label="Hidden peer",
        source_type="mesh_peer",
        source="mesh_peer",
        execution_location="remote",
        namespace="peer_hidden",
        display_name="Secret alias",
        provenance=ToolingToolProvenance(
            provider_peer_id=peer_id,
            provider_service_instance_id=f"remote:{peer_id}:Tooling",
            provider_kind="mesh_peer",
            source="unknown",
            advertised_name="secret",
        ),
    )
    loaded = Mock(name="loaded-hidden")
    loaded.name = info.name
    loaded.description = "secret remote tool"
    tooling_service.tools_manager.get_tools.return_value = [loaded]
    tooling_service._serialize_tool = Mock(return_value=info)
    tooling_service._consumer_mesh_execution_authorized = AsyncMock(return_value=False)

    listed = await tooling_service._on_get_tools(ToolingGetToolsRequest())
    searched = await tooling_service._on_get_tools(ToolingGetToolsRequest(query="secret", top_k=10))
    selector = MeshAddressSelector(peer_id=peer_id, service_instance_id=f"remote:{peer_id}:Tooling")
    exact_results = [
        await tooling_service._on_get_tool_by_name(
            ToolingGetToolByNameRequest(name=name, mesh_selector=selector)
        )
        for name in (info.global_tool_id, info.name, info.display_name)
    ]

    assert listed.tools == [] and searched.tools == []
    assert all(not result.found and result.name == "" for result in exact_results)


@pytest.mark.asyncio
async def test_active_external_discovery_requires_exact_evidence_and_returns_projection(
    export_service,
) -> None:
    service, _state, alpha, _beta = export_service
    service._mesh_projection_enforcement_active = True

    listed = await service._on_get_tools(
        ToolingGetToolsRequest(top_k=10_000),
        _execution_envelope(ToolingMethods.GET_TOOLS),
    )
    assert alpha.name in {tool.local_name for tool in listed.tools}

    wrong_method = await service._on_get_tools(
        ToolingGetToolsRequest(top_k=10_000),
        _execution_envelope(ToolingMethods.GET_TOOL_BY_NAME),
    )
    assert wrong_method.tools == []

    exact = await service._on_get_tool_by_name(
        ToolingGetToolByNameRequest(name=alpha.name),
        _execution_envelope(ToolingMethods.GET_TOOL_BY_NAME),
    )
    assert exact.found is True and exact.name == alpha.name


@pytest.mark.asyncio
async def test_activation_cas_keeps_legacy_guard_until_exact_success(tooling_service):
    tooling_service._mesh_projection_enforcement_active = False
    tooling_service.bus.request = AsyncMock(
        return_value=QueryResult(ok=False, error="db unavailable")
    )
    await tooling_service._activate_mesh_projection_enforcement()
    assert tooling_service._mesh_projection_enforcement_active is False

    failed_state = QueryResult(
        ok=True,
        data={"state": {"active": False, "legacy_guard_retired": False, "revision": 2}},
    )
    tooling_service.bus.request = AsyncMock(return_value=failed_state)
    await tooling_service._activate_mesh_projection_enforcement()
    assert tooling_service._mesh_projection_enforcement_active is False
    tooling_service.bus.request.assert_awaited_once()

    ready = QueryResult(
        ok=True,
        data={"state": {"active": True, "legacy_guard_retired": True, "revision": 3}},
    )
    tooling_service.bus.request = AsyncMock(return_value=ready)
    await tooling_service._activate_mesh_projection_enforcement()
    assert tooling_service._mesh_projection_enforcement_active is True


@pytest.mark.asyncio
async def test_readiness_report_requires_normalized_schema_and_durable_legacy_guard(
    tooling_service,
):
    table_names = [
        "tooling_remote_catalog_headers",
        "tooling_remote_catalog_tools",
        "tooling_remote_catalog_syncs",
        "tooling_remote_catalog_stage_pages",
        "tooling_remote_catalog_stage_tools",
        "tooling_remote_catalog_stage_retirements",
        "tooling_mesh_activation_state",
    ]
    tooling_service._stable_peer_id = None
    tooling_service._load_stable_tooling_peer_id = AsyncMock(
        side_effect=lambda: setattr(tooling_service, "_stable_peer_id", "provider-ready")
    )
    tooling_service._db_sql = AsyncMock(return_value=[{"name": name} for name in table_names])

    async def readiness_request(topic, _payload, **_kwargs):
        if topic == DBMethods.GET_TOOLING_MESH_ACTIVATION_STATE:
            return QueryResult(
                ok=True,
                data={
                    "state": {
                        "active": False,
                        "legacy_guard_retired": False,
                        "revision": 0,
                    }
                },
            )
        if topic == DBMethods.GET_TOOLING_EXPOSURE_LEDGER:
            return QueryResult(
                ok=True,
                data=DBGetToolingExposureLedgerResponse(entries=[]).model_dump(),
            )
        raise AssertionError(topic)

    tooling_service.bus.request = AsyncMock(side_effect=readiness_request)

    report = await tooling_service._on_get_mesh_projection_readiness(SimpleNamespace())

    tooling_service._load_stable_tooling_peer_id.assert_awaited_once()
    assert report.ready is True
    assert report.normalized_catalog is True
    assert report.legacy_guard_active is True
    assert report.durable_active is False

    tooling_service._db_sql.return_value = []
    report = await tooling_service._on_get_mesh_projection_readiness(SimpleNamespace())
    assert report.ready is False


@pytest.mark.asyncio
async def test_consumer_switch_cancels_staging_and_reenable_starts_full_baseline(
    tooling_service,
):
    peer_id = "peer-switch"
    blocker = asyncio.create_task(asyncio.Event().wait())
    tooling_service._projection_sync_tasks[peer_id] = blocker
    tooling_service._projection_sync_ids[peer_id] = "sync-in-flight-0001"
    tooling_service._tool_export_snapshot = AsyncMock(
        return_value=SimpleNamespace(
            mesh_switches=ToolingMeshKillSwitches(consumer_mesh_tooling_enabled=False)
        )
    )
    tooling_service.bus.request = AsyncMock(return_value=QueryResult(ok=True, data={}))
    request = ToolingProjectionSyncRequested(
        provider_peer_id=peer_id,
        service_instance_id=f"remote:{peer_id}:Tooling",
        reason_code="switch_changed",
    )

    await tooling_service._on_projection_sync_requested(request)
    await asyncio.gather(blocker, return_exceptions=True)

    methods = [call.args[0] for call in tooling_service.bus.request.await_args_list]
    assert blocker.cancelled()
    assert methods == [
        DBMethods.ABORT_TOOLING_REMOTE_CATALOG_SYNC,
        DBMethods.SET_TOOLING_REMOTE_PROVIDER_AVAILABILITY,
    ]
    abort_request = tooling_service.bus.request.await_args_list[0].args[1]
    assert abort_request.sync_id == "sync-in-flight-0001"
    assert abort_request.reason_code == "consumer_mesh_tooling_disabled"

    tooling_service._tool_export_snapshot = AsyncMock(
        return_value=SimpleNamespace(
            mesh_switches=ToolingMeshKillSwitches(consumer_mesh_tooling_enabled=True)
        )
    )

    async def reenabled(method, payload, **_kwargs):
        if method == DBMethods.GET_TOOLING_REMOTE_CATALOG:
            return QueryResult(ok=True, data={"headers": []})
        if method == "Gateway.FetchToolingExportCatalogPage":
            assert payload.request.cursor is None
            return QueryResult(ok=False, error="offline")
        raise AssertionError(f"unexpected method {method}")

    tooling_service.bus.request = AsyncMock(side_effect=reenabled)
    with pytest.raises(RuntimeError, match="projection_fetch_failed"):
        await tooling_service._on_projection_sync_requested(request)


def _sync_page(
    *,
    revision: str,
    complete: bool,
    next_cursor: str | None = None,
    tools: list[ToolingToolInfo] | None = None,
):
    return ToolingGetExportCatalogResponse(
        provider_peer_id="peer-race",
        service_instance_id="remote:peer-race:Tooling",
        authority_revision=ToolingProjectionAuthorityRevision(
            catalog_revision=1,
            export_policy_revision=2,
            auth_grant_revision=3,
            manifest_revision=4,
            switch_revision=5,
        ),
        projection_revision=revision,
        projection_digest=("a" if revision == "old" else "b") * 64,
        page_index=0,
        page_size=100,
        page_hash="c" * 64,
        complete=complete,
        next_cursor=next_cursor,
        tools=tools or [],
        total_count=len(tools or []) if complete else None,
        final_checksum=("d" * 64) if complete else None,
    )


@pytest.mark.asyncio
async def test_projection_sync_stages_the_validated_page_service_identity(tooling_service):
    provider = "peer-race"
    local_service_instance_id = f"local:{provider}:Tooling"
    tooling_service._sharing_policy = ToolingSharingPolicy()
    tooling_service._tool_export_snapshot = AsyncMock(
        return_value=SimpleNamespace(
            mesh_switches=ToolingMeshKillSwitches(consumer_mesh_tooling_enabled=True)
        )
    )
    tooling_service._audit_tooling_event = AsyncMock()
    begin_requests = []

    async def request_bus(method, payload, **_kwargs):
        if method == DBMethods.GET_TOOLING_REMOTE_CATALOG:
            return QueryResult(ok=True, data={"headers": []})
        if method == "Gateway.FetchToolingExportCatalogPage":
            page = _sync_page(revision="local-provider", complete=True).model_copy(
                update={"service_instance_id": local_service_instance_id}
            )
            return QueryResult(
                ok=True,
                data=GatewayFetchToolingExportCatalogPageResponse(
                    page=page,
                    granted_permissions=[
                        "Native.GetDeviceStatus",
                        "Tooling.GetExportCatalog",
                    ],
                ).model_dump(),
            )
        if method == DBMethods.BEGIN_TOOLING_REMOTE_CATALOG_SYNC:
            begin_requests.append(payload)
            return QueryResult(ok=True, data={})
        if method == DBMethods.APPEND_TOOLING_REMOTE_CATALOG_PAGE:
            return QueryResult(ok=True, data={})
        if method == DBMethods.COMMIT_TOOLING_REMOTE_CATALOG_SYNC:
            return QueryResult(ok=True, data={"ok": True})
        raise AssertionError(method)

    tooling_service.bus.request = AsyncMock(side_effect=request_bus)
    await tooling_service._on_projection_sync_requested(
        ToolingProjectionSyncRequested(
            provider_peer_id=provider,
            service_instance_id=f"remote:{provider}:Tooling",
            reason_code="provider_lease_available",
            force_full_snapshot=True,
        )
    )

    assert len(begin_requests) == 1
    assert begin_requests[0].service_instance_id == local_service_instance_id
    assert tooling_service._remote_provider_states[
        (provider, local_service_instance_id)
    ] == (
        ["Native.GetDeviceStatus", "Tooling.GetExportCatalog"],
        True,
    )


@pytest.mark.asyncio
async def test_restart_live_sync_stays_stale_until_alias_policy_persists(tooling_service):
    """A live manifest cannot reactivate a renamed tool around a durable refusal."""

    provider = "peer-race"
    legacy_id = "legacy:calendar.list"
    canonical_id = "aurora-tool:v1:peer-race:Tooling:calendar.list"
    legacy_allow_id = "legacy:calendar.create"
    canonical_allow_id = "aurora-tool:v1:peer-race:Tooling:calendar.create"
    old_policy = ToolingSharingPolicy(
        default_share=True,
        rules=[
            ToolingSharingPolicyRule(
                rule_id="durable-refusal",
                provider_peer_id=provider,
                global_tool_id=legacy_id,
                share=False,
                approval_mode="deny_all",
            ),
            ToolingSharingPolicyRule(
                rule_id="durable-approval",
                provider_peer_id=provider,
                global_tool_id=legacy_allow_id,
                share=True,
                approval_mode="approve_all_for_peer",
            ),
        ],
    )
    tooling_service._sharing_policy = old_policy
    tooling_service._tool_export_snapshot = AsyncMock(
        return_value=SimpleNamespace(
            mesh_switches=ToolingMeshKillSwitches(consumer_mesh_tooling_enabled=True)
        )
    )
    methods: list[str] = []
    finalize_ok = True
    stale_ok = False

    async def request_bus(method, payload, **_kwargs):
        methods.append(method)
        if method == DBMethods.GET_TOOLING_REMOTE_CATALOG:
            return QueryResult(ok=True, data={"headers": []})
        if method == "Gateway.FetchToolingExportCatalogPage":
            return QueryResult(
                ok=True,
                data=GatewayFetchToolingExportCatalogPageResponse(
                    page=_sync_page(revision="live", complete=True)
                ).model_dump(),
            )
        if method in {
            DBMethods.BEGIN_TOOLING_REMOTE_CATALOG_SYNC,
            DBMethods.APPEND_TOOLING_REMOTE_CATALOG_PAGE,
        }:
            return QueryResult(ok=True, data={})
        if method == DBMethods.SET_TOOLING_REMOTE_PROVIDER_AVAILABILITY:
            return QueryResult(
                ok=stale_ok,
                data={"ok": stale_ok, "changed": False, "error": "injected_stale_failure"},
            )
        if method == DBMethods.COMMIT_TOOLING_REMOTE_CATALOG_SYNC:
            assert payload.defer_activation_for_policy_reconciliation is True
            return QueryResult(
                ok=True,
                data={
                    "ok": True,
                    "generation": 1,
                    "header": {
                        "current_generation": 1,
                        "projection_revision": "live",
                    },
                },
            )
        if method == DBMethods.FINALIZE_TOOLING_REMOTE_CATALOG_POLICY:
            return QueryResult(
                ok=finalize_ok,
                data={
                    "ok": finalize_ok,
                    "changed": finalize_ok,
                    "error": None if finalize_ok else "injected_finalize_failure",
                },
            )
        if method == DBMethods.RESOLVE_TOOLING_REMOTE_TOOL_ALIASES:
            return QueryResult(
                ok=True,
                data={
                    "canonical_by_requested_id": {
                        requested: (
                            canonical_id
                            if requested == legacy_id
                            else (canonical_allow_id if requested == legacy_allow_id else requested)
                        )
                        for requested in payload.global_tool_ids
                    }
                },
            )
        raise AssertionError(method)

    tooling_service.bus.request = AsyncMock(side_effect=request_bus)
    tooling_service._config.aupdate_config = AsyncMock(return_value=False)
    sync = ToolingProjectionSyncRequested(
        provider_peer_id=provider,
        service_instance_id=f"remote:{provider}:Tooling",
        reason_code="peer_manifest_projection_ready",
        force_full_snapshot=True,
    )

    with pytest.raises(RuntimeError, match="alias migration was not persisted"):
        await tooling_service._on_projection_sync_requested(sync)
    assert methods[-1] == DBMethods.SET_TOOLING_REMOTE_PROVIDER_AVAILABILITY
    stale_request = tooling_service.bus.request.await_args_list[-1].args[1]
    assert stale_request.availability == "stale"
    assert stale_request.reason_code == "policy_alias_reconciliation_failed"
    assert DBMethods.ABORT_TOOLING_REMOTE_CATALOG_SYNC not in methods
    assert canonical_id in {rule.global_tool_id for rule in tooling_service._sharing_policy.rules}
    assert canonical_allow_id not in {
        rule.global_tool_id for rule in tooling_service._sharing_policy.rules
    }

    # Restart reloads the old Config selector. Even with another live manifest,
    # reconciliation failure durably leaves the new committed generation stale.
    tooling_service._sharing_policy = old_policy.model_copy(deep=True)
    with pytest.raises(RuntimeError, match="alias migration was not persisted"):
        await tooling_service._on_projection_sync_requested(sync)
    assert methods.count(DBMethods.SET_TOOLING_REMOTE_PROVIDER_AVAILABILITY) == 2
    assert canonical_allow_id not in {
        rule.global_tool_id for rule in tooling_service._sharing_policy.rules
    }

    # Only a fresh successful commit plus Config persistence may reactivate it.
    tooling_service._sharing_policy = old_policy.model_copy(deep=True)
    tooling_service._config.aupdate_config = AsyncMock(return_value=True)
    finalize_ok = False
    with pytest.raises(RuntimeError, match="projection_policy_finalize_failed"):
        await tooling_service._on_projection_sync_requested(sync)
    assert provider not in tooling_service._policy_reconciliation_inflight
    assert [rule.global_tool_id for rule in tooling_service._sharing_policy.rules] == [
        canonical_id,
        canonical_allow_id,
    ]

    # A fresh generation can retry activation after canonical Config selectors
    # are already durable; the previous finalize failure never exposed tools.
    finalize_ok = True
    await tooling_service._on_projection_sync_requested(sync)
    assert methods.count(DBMethods.SET_TOOLING_REMOTE_PROVIDER_AVAILABILITY) == 2
    assert [rule.global_tool_id for rule in tooling_service._sharing_policy.rules] == [
        canonical_id,
        canonical_allow_id,
    ]
    assert tooling_service._sharing_policy.rules[0].share is False


@pytest.mark.asyncio
async def test_policy_reconciliation_inflight_blocks_binding_and_execution(tooling_service):
    provider = "peer-race"
    legacy_id = "legacy:calendar.list"
    canonical_id = "aurora-tool:v1:peer-race:Tooling:calendar.list"
    service_instance = f"remote:{provider}:Tooling"
    remote_tool = ToolingToolInfo(
        name="peer-race_calendar_list",
        local_name="calendar_list",
        global_tool_id=canonical_id,
        tool_id_scheme="aurora-tool",
        tool_id_version=1,
        tool_contract_id="calendar.list",
        share_group_id="calendar",
        share_group_label="Calendar",
        provider_peer_id=provider,
        provider_service_instance_id=service_instance,
        provider_label="Peer race",
        source_type="mesh_peer",
        source="mesh_peer",
        execution_location="remote",
        namespace="peer-race",
        display_name="List calendar",
        provenance=ToolingToolProvenance(
            provider_peer_id=provider,
            provider_service_instance_id=service_instance,
            provider_kind="mesh_peer",
            source="unknown",
            advertised_name="calendar_list",
        ),
    )
    tooling_service._sharing_policy = ToolingSharingPolicy(
        rules=[
            ToolingSharingPolicyRule(
                rule_id="deny-old",
                provider_peer_id=provider,
                global_tool_id=legacy_id,
                share=False,
                approval_mode="deny_all",
            )
        ]
    )
    tooling_service._mesh_projection_enforcement_active = True
    tooling_service._tool_export_snapshot = AsyncMock(
        return_value=SimpleNamespace(
            mesh_switches=ToolingMeshKillSwitches(consumer_mesh_tooling_enabled=True)
        )
    )
    tooling_service._remote_tooling_candidates = Mock(
        return_value=[
            SimpleNamespace(
                peer=SimpleNamespace(peer_id=provider),
                eligible=True,
                decision=SimpleNamespace(granted_permissions=["Tooling.GetTools"]),
            )
        ]
    )
    persist_started = asyncio.Event()
    release_persist = asyncio.Event()
    committed = False
    finalized = False

    async def persist(*_args, **_kwargs):
        persist_started.set()
        await release_persist.wait()
        return True

    async def request_bus(method, payload, **_kwargs):
        nonlocal committed, finalized
        if method == DBMethods.GET_TOOLING_REMOTE_CATALOG:
            if not committed:
                return QueryResult(ok=True, data={"headers": [], "tools": []})
            return QueryResult(
                ok=True,
                data={
                    "headers": [
                        {
                            "peer_id": provider,
                            "provider_id": provider,
                            "service_instance_id": service_instance,
                            "protocol_tier": "projection_v1",
                            "projection_revision": "concurrent-v1",
                            "projection_digest": "a" * 64,
                            "authority_revision": {},
                            "current_generation": 1,
                            "sync_state": "committed",
                            "availability": "active",
                        }
                    ],
                    "tools": [
                        {
                            "peer_id": provider,
                            "provider_id": provider,
                            "tool": remote_tool.model_dump(mode="python"),
                            "availability": "active",
                            "active_generation": 1,
                        }
                    ],
                },
            )
        if method == "Gateway.FetchToolingExportCatalogPage":
            return QueryResult(
                ok=True,
                data=GatewayFetchToolingExportCatalogPageResponse(
                    page=_sync_page(revision="concurrent-v1", complete=True, tools=[remote_tool])
                ).model_dump(),
            )
        if method in {
            DBMethods.BEGIN_TOOLING_REMOTE_CATALOG_SYNC,
            DBMethods.APPEND_TOOLING_REMOTE_CATALOG_PAGE,
        }:
            return QueryResult(ok=True, data={})
        if method == DBMethods.COMMIT_TOOLING_REMOTE_CATALOG_SYNC:
            assert payload.defer_activation_for_policy_reconciliation is True
            committed = True
            return QueryResult(
                ok=True,
                data={
                    "ok": True,
                    "generation": 1,
                    "header": {
                        "current_generation": 1,
                        "projection_revision": "concurrent-v1",
                    },
                },
            )
        if method == DBMethods.RESOLVE_TOOLING_REMOTE_TOOL_ALIASES:
            return QueryResult(
                ok=True,
                data={"canonical_by_requested_id": {legacy_id: canonical_id}},
            )
        if method == DBMethods.FINALIZE_TOOLING_REMOTE_CATALOG_POLICY:
            finalized = True
            return QueryResult(ok=True, data={"ok": True, "changed": True})
        raise AssertionError(method)

    tooling_service.bus.request = AsyncMock(side_effect=request_bus)
    tooling_service._config.aupdate_config = AsyncMock(side_effect=persist)
    sync = asyncio.create_task(
        tooling_service._on_projection_sync_requested(
            ToolingProjectionSyncRequested(
                provider_peer_id=provider,
                service_instance_id=service_instance,
                reason_code="peer_manifest_projection_ready",
                force_full_snapshot=True,
            )
        )
    )
    await persist_started.wait()

    assert committed is True and finalized is False
    assert await tooling_service._load_normalized_bindable_remote_catalogs() == []
    execute = ToolingExecuteToolRequest(
        tool_name=canonical_id,
        arguments={},
        mesh_selector=MeshAddressSelector(
            peer_id=provider,
            service_instance_id=service_instance,
            tool_id=canonical_id,
        ),
    )
    assert await tooling_service._consumer_mesh_execution_authorized(execute) is False

    release_persist.set()
    await sync
    assert finalized is True
    visible = await tooling_service._load_normalized_bindable_remote_catalogs()
    assert [tool.global_tool_id for tool in visible[0].tools] == [canonical_id]
    visible_tool = visible[0].tools[0]
    assert visible_tool.name == "peer-race_calendar_list"
    assert visible_tool.display_name == "peer-race.calendar_list"
    assert visible_tool.source_type == "mesh_peer"
    assert visible_tool.source == "mesh_peer"
    assert visible_tool.execution_location == "remote"
    assert visible_tool.exportable is False
    assert visible_tool.provider_service_instance_id == service_instance
    assert visible_tool.provenance.provider_kind == "mesh_peer"
    assert await tooling_service._consumer_mesh_execution_authorized(execute) is True


@pytest.mark.asyncio
@pytest.mark.parametrize("fail_first", [False, True])
async def test_overlapping_projection_invalidation_reruns_latest_after_success_or_failure(
    tooling_service,
    fail_first,
):
    peer_id = "peer-race"
    tooling_service._tool_export_snapshot = AsyncMock(
        return_value=SimpleNamespace(
            mesh_switches=ToolingMeshKillSwitches(consumer_mesh_tooling_enabled=True)
        )
    )
    first_fetch_started = asyncio.Event()
    release_first_fetch = asyncio.Event()
    latest_fetch_started = asyncio.Event()
    release_latest_fetch = asyncio.Event()
    fetch_count = 0
    commit_revisions: list[str] = []
    staged_revision = ""

    async def request_bus(method, payload, **_kwargs):
        nonlocal fetch_count, staged_revision
        if method == DBMethods.GET_TOOLING_REMOTE_CATALOG:
            return QueryResult(ok=True, data={"headers": []})
        if method == "Gateway.FetchToolingExportCatalogPage":
            fetch_count += 1
            if fetch_count == 1:
                first_fetch_started.set()
                await release_first_fetch.wait()
                if fail_first:
                    return QueryResult(ok=False, error="first_fetch_failed")
                page = _sync_page(revision="old", complete=False, next_cursor="old-next")
            elif fetch_count == 2 and not fail_first:
                page = _sync_page(revision="old", complete=True)
            else:
                latest_fetch_started.set()
                await release_latest_fetch.wait()
                page = _sync_page(revision="latest", complete=True)
            return QueryResult(
                ok=True,
                data=GatewayFetchToolingExportCatalogPageResponse(page=page).model_dump(),
            )
        if method == DBMethods.BEGIN_TOOLING_REMOTE_CATALOG_SYNC:
            staged_revision = payload.projection_revision
            return QueryResult(ok=True, data={})
        if method == DBMethods.APPEND_TOOLING_REMOTE_CATALOG_PAGE:
            return QueryResult(ok=True, data={})
        if method == DBMethods.COMMIT_TOOLING_REMOTE_CATALOG_SYNC:
            commit_revisions.append(staged_revision)
            return QueryResult(ok=True, data={})
        if method == DBMethods.ABORT_TOOLING_REMOTE_CATALOG_SYNC:
            return QueryResult(ok=True, data={})
        raise AssertionError(method)

    tooling_service.bus.request = AsyncMock(side_effect=request_bus)
    first_request = ToolingProjectionSyncRequested(
        provider_peer_id=peer_id,
        service_instance_id=f"remote:{peer_id}:Tooling",
        reason_code="catalog_changed",
    )
    latest_request = first_request.model_copy(update={"reason_code": "policy_changed"})
    first_run = asyncio.create_task(tooling_service._on_projection_sync_requested(first_request))
    await first_fetch_started.wait()
    await tooling_service._on_projection_sync_requested(latest_request)
    assert tooling_service._projection_sync_pending[peer_id].reason_code == "policy_changed"
    release_first_fetch.set()
    if fail_first:
        with pytest.raises(RuntimeError, match="projection_fetch_failed"):
            await first_run
    else:
        await first_run
    await latest_fetch_started.wait()
    rerun = tooling_service._projection_sync_tasks[peer_id]
    release_latest_fetch.set()
    await rerun

    assert commit_revisions[-1] == "latest"
    assert peer_id not in tooling_service._projection_sync_pending
    assert peer_id not in tooling_service._projection_sync_tasks


@pytest.mark.asyncio
async def test_management_activation_state_matches_runtime_durable_observation(export_service):
    service, *_ = export_service
    snapshot = await service._tool_export_snapshot(include_rules=True)
    service._tool_export_snapshot = AsyncMock(
        return_value=snapshot.model_copy(
            update={
                "mesh_switches": snapshot.mesh_switches.model_copy(
                    update={"enforcement_active": True}
                )
            }
        )
    )
    service._mesh_projection_enforcement_active = False
    inactive = await service._on_get_tool_export_policy(ToolingGetToolExportPolicyRequest())
    assert inactive.mesh_switches.enforcement_active is False

    service._mesh_projection_enforcement_active = True
    active = await service._on_get_tool_export_policy(ToolingGetToolExportPolicyRequest())
    assert active.mesh_switches.enforcement_active is True
