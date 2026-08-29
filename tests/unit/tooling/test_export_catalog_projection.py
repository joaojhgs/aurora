from app.services.tooling.projection import (
    ProjectionContext,
    build_recipient_blocked_inventory,
    permission_satisfies,
)
from app.services.tooling.service import ToolingService  # noqa: F401
from app.shared.contracts.models.tooling import (
    ToolingExportPolicy,
    ToolingMethods,
    ToolingProjectionAuthorityRevision,
    ToolingToolInfo,
    ToolingToolProvenance,
)


def test_use_grant_cannot_satisfy_manage_only_permission() -> None:
    assert permission_satisfies(ToolingMethods.GET_TOOLS, [ToolingMethods.GET_TOOLS])
    assert not permission_satisfies(ToolingMethods.SET_POLICY_MODE, ["Tooling.use"])
    assert permission_satisfies(
        ToolingMethods.SET_POLICY_MODE,
        [ToolingMethods.SET_POLICY_MODE],
    )
    assert permission_satisfies(ToolingMethods.SET_POLICY_MODE, ["Tooling.*"])


def test_first_sync_inventory_explains_tool_specific_permission_block() -> None:
    tool = ToolingToolInfo(
        name="speak",
        local_name="speak",
        global_tool_id="aurora-tool:v1:provider:Tooling:speak",
        tool_id_scheme="aurora-tool",
        tool_id_version=1,
        tool_contract_id="speak",
        share_group_id="core:tts",
        share_group_label="TTS",
        exportable=True,
        provider_peer_id="provider",
        provider_service_instance_id="remote:provider:Tooling",
        namespace="provider",
        display_name="provider.speak",
        source_type="local",
        source="core",
        execution_location="local",
        required_permissions=["Tooling.ExecuteTool", "TTS.Request"],
        provenance=ToolingToolProvenance(
            provider_peer_id="provider",
            provider_service_instance_id="remote:provider:Tooling",
            provider_kind="local",
            source="core",
            advertised_name="speak",
        ),
    )
    blocked = build_recipient_blocked_inventory(
        [tool],
        context=ProjectionContext(
            recipient_peer_id="consumer",
            recipient_permissions=("Tooling.GetTools", "Tooling.ExecuteTool"),
            authority_revision=ToolingProjectionAuthorityRevision(
                catalog_revision=1,
                export_policy_revision=1,
                auth_grant_revision=1,
                manifest_revision=1,
                switch_revision=1,
            ),
            provider_enabled=True,
            service_exported=True,
            discovery_exported=True,
            execution_exported=True,
        ),
        policy=ToolingExportPolicy(default_state="shared", revision=1, initialized=True),
        rules=[],
    )
    assert len(blocked) == 1
    assert blocked[0].tool.global_tool_id == tool.global_tool_id
    assert blocked[0].missing_permissions == ["TTS.Request"]
