"""Tooling service contract models."""

from typing import Any, Literal

from pydantic import Field, SecretStr, field_validator, model_validator

from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.registry import IOModel

JS_SAFE_INTEGER_MAX = 2**53 - 1


# Module identifier
class ToolingModule:
    """Module identifier for Tooling service."""

    NAME = "Tooling"


# Method identifiers
class ToolingMethods:
    """Full method identifiers for Tooling service."""

    GET_TOOLS = f"{ToolingModule.NAME}.GetTools"
    GET_TOOL_CATALOG = f"{ToolingModule.NAME}.GetToolCatalog"
    GET_EXPORT_CATALOG = f"{ToolingModule.NAME}.GetExportCatalog"
    GET_TOOL_BY_NAME = f"{ToolingModule.NAME}.GetToolByName"
    GET_STATS = f"{ToolingModule.NAME}.GetStats"
    GET_MCP_STATUS = f"{ToolingModule.NAME}.GetMCPStatus"
    GET_SHARING_POLICY = f"{ToolingModule.NAME}.GetSharingPolicy"
    SET_SHARING_POLICY = f"{ToolingModule.NAME}.SetSharingPolicy"
    TEST_SHARING_POLICY = f"{ToolingModule.NAME}.TestSharingPolicy"
    GET_TOOL_EXPORT_POLICY = f"{ToolingModule.NAME}.GetToolExportPolicy"
    SET_TOOL_EXPORT_DEFAULT = f"{ToolingModule.NAME}.SetToolExportDefault"
    UPSERT_TOOL_GROUP_EXPORT_POLICY = f"{ToolingModule.NAME}.UpsertToolGroupExportPolicy"
    UPSERT_TOOL_EXPORT_OVERRIDE = f"{ToolingModule.NAME}.UpsertToolExportOverride"
    CLEAR_TOOL_EXPORT_OVERRIDE = f"{ToolingModule.NAME}.ClearToolExportOverride"
    PREVIEW_TOOL_EXPORT_DECISION = f"{ToolingModule.NAME}.PreviewToolExportDecision"
    PREPARE_EXECUTION = f"{ToolingModule.NAME}.PrepareExecution"
    REQUEST_APPROVAL = f"{ToolingModule.NAME}.RequestApproval"
    CONFIRM_EXECUTION = f"{ToolingModule.NAME}.ConfirmExecution"
    LIST_APPROVAL_GRANTS = f"{ToolingModule.NAME}.ListApprovalGrants"
    CREATE_APPROVAL_GRANT = f"{ToolingModule.NAME}.CreateApprovalGrant"
    REVOKE_APPROVAL_GRANT = f"{ToolingModule.NAME}.RevokeApprovalGrant"
    EVALUATE_APPROVAL_GRANT = f"{ToolingModule.NAME}.EvaluateApprovalGrant"
    GET_POLICY_SUMMARY = f"{ToolingModule.NAME}.GetPolicySummary"
    LIST_TOOL_SOURCES = f"{ToolingModule.NAME}.ListToolSources"
    GET_TOOL_SOURCE_DETAIL = f"{ToolingModule.NAME}.GetToolSourceDetail"
    ACCEPT_REMOTE_TOOL_SCHEMA = f"{ToolingModule.NAME}.AcceptRemoteToolSchema"
    SET_POLICY_MODE = f"{ToolingModule.NAME}.SetPolicyMode"
    UPSERT_SOURCE_POLICY = f"{ToolingModule.NAME}.UpsertSourcePolicy"
    CLEAR_SOURCE_POLICY = f"{ToolingModule.NAME}.ClearSourcePolicy"
    UPSERT_TOOL_POLICY_OVERRIDE = f"{ToolingModule.NAME}.UpsertToolPolicyOverride"
    CLEAR_TOOL_POLICY_OVERRIDE = f"{ToolingModule.NAME}.ClearToolPolicyOverride"
    LIST_PENDING_APPROVALS = f"{ToolingModule.NAME}.ListPendingApprovals"
    LIST_POLICY_AUDIT_EVENTS = f"{ToolingModule.NAME}.ListPolicyAuditEvents"
    GET_ONBOARDING_STATUS = f"{ToolingModule.NAME}.GetOnboardingStatus"
    TEST_MCP_SOURCE = f"{ToolingModule.NAME}.TestMCPSource"
    CREATE_MCP_SOURCE = f"{ToolingModule.NAME}.CreateMCPSource"
    TEST_PLUGIN_SOURCE = f"{ToolingModule.NAME}.TestPluginSource"
    CREATE_PLUGIN_SOURCE = f"{ToolingModule.NAME}.CreatePluginSource"
    EXECUTE_TOOL = f"{ToolingModule.NAME}.ExecuteTool"
    REMOTE_CATALOG_ANNOUNCED = f"{ToolingModule.NAME}.RemoteCatalogAnnounced"
    REMOTE_CATALOG_DELTA_ANNOUNCED = f"{ToolingModule.NAME}.RemoteCatalogDeltaAnnounced"
    REMOTE_CATALOG_REMOVED = f"{ToolingModule.NAME}.RemoteCatalogRemoved"
    REMOTE_CATALOG_REFRESH_REQUESTED = f"{ToolingModule.NAME}.RemoteCatalogRefreshRequested"
    PROJECTION_INVALIDATED = f"{ToolingModule.NAME}.ProjectionInvalidated"
    PROJECTION_SYNC_REQUESTED = f"{ToolingModule.NAME}.ProjectionSyncRequested"
    GET_MESH_PROJECTION_READINESS = f"{ToolingModule.NAME}.GetMeshProjectionReadiness"
    MESH_PROJECTION_READINESS_CHANGED = f"{ToolingModule.NAME}.MeshProjectionReadinessChanged"
    MESH_ENFORCEMENT_ACTIVATED = f"{ToolingModule.NAME}.MeshEnforcementActivated"
    RELOAD_MCP_TOOLS = f"{ToolingModule.NAME}.ReloadMCPTools"
    HEALTH_CHECK = f"{ToolingModule.NAME}.HealthCheck"
    TOOLS_INITIALIZED = f"{ToolingModule.NAME}.ToolsInitialized"
    TOOLS_RELOADED = f"{ToolingModule.NAME}.ToolsReloaded"


ToolingApprovalMode = Literal[
    "deny_all",
    "ask_each_time",
    "allow_once",
    "allow_until_expiry",
    "approve_all_for_session",
    "approve_all_for_peer",
    "approve_all_local_safe",
    "dry_run_only",
]

ToolingOperationClass = Literal["read", "write", "external", "admin", "hardware", "data-egress"]

ToolingSourceClass = Literal["core", "plugin", "mcp", "toolkit", "mesh_peer", "unknown"]

ToolingExecutionLocation = Literal["local", "remote"]

ToolingSafetyClass = Literal["standard", "sensitive", "dangerous"]

ToolingRiskClass = Literal["standard", "sensitive", "dangerous"]
ToolingPolicyMode = Literal["enforce", "dry_run_only", "deny_all", "unrestricted_except_blocked"]
ToolingTrustTier = Literal["trusted", "untrusted", "blocked"]
ToolingCapabilityClass = Literal[
    "read", "write", "execute", "network", "secrets", "device", "admin"
]
ToolingArgumentVisibility = Literal[
    "display",
    "hash_only",
    "secret",
    "raw_never",
    "support_bundle_redacted",
]
ToolingApprovalGrantScope = Literal[
    "once",
    "session",
    "until_expiry",
    "always",
    "scheduled_execution",
    "deny_once",
    "deny_always",
]

ToolingExportState = Literal["shared", "unshared"]
ToolingExportScopeType = Literal["group", "tool"]
ToolingExportDecisionSource = Literal[
    "peer_tool", "global_tool", "peer_group", "global_group", "global_default"
]
ToolingExportProtocolTier = Literal["legacy_unsupported", "projection_v1", "projection_v1_delta"]
ToolingExportPrerequisiteState = Literal["satisfied", "blocked", "unknown", "not_applicable"]
ToolingExportPrerequisiteSource = Literal[
    "tool_identity", "mesh_policy", "mesh_switch", "peer_authority", "runtime"
]
ToolingRemoteAvailability = Literal[
    "active",
    "unshared",
    "permission_blocked",
    "provider_unavailable",
    "removed",
    "stale",
    "schema_changed",
    "protocol_unsupported",
]

# One public ceremony value prevents clients from inventing subtly different
# confirmation phrases.  Tooling service handlers will enforce it in G012's
# integration lane; the DB receives already-authorized mutations only.
TOOLING_EXPORT_POLICY_CONFIRMATION_TEXT = "CONFIRM TOOL EXPORT POLICY CHANGE"


class ToolingGetToolsRequest(IOModel):
    """Request to get available tools."""

    query: str | None = None
    top_k: int = Field(default=100, ge=0, le=JS_SAFE_INTEGER_MAX)
    mesh_selector: MeshAddressSelector | None = None


class ToolingRateLimitHints(IOModel):
    """Optional rate-limit hints for a discovered tool provider."""

    max_calls: int | None = Field(default=None, ge=0, le=JS_SAFE_INTEGER_MAX)
    window_seconds: int | None = Field(default=None, ge=0, le=JS_SAFE_INTEGER_MAX)
    policy: str | None = None


class ToolingToolProvenance(IOModel):
    """Provenance carried with a discovered tool."""

    provider_peer_id: str
    provider_service_instance_id: str
    provider_kind: Literal["local", "mesh_peer"] = "local"
    source: Literal["core", "plugin", "mcp", "unknown"] = "unknown"
    advertised_name: str
    stable_source_id: str | None = None
    provider_tool_id: str | None = None


class ToolingToolInfo(IOModel):
    """Typed metadata for a discovered tool.

    ``name`` remains the bindable tool name expected by existing
    orchestrator code. For local-only discovery it is the provider-local
    name; for provider-selected mesh discovery it is namespaced to avoid
    collisions.
    """

    name: str
    local_name: str
    global_tool_id: str
    tool_id_scheme: Literal["aurora-tool", "legacy"] = "legacy"
    tool_id_version: Literal[0, 1] = 0
    tool_contract_id: str = ""
    share_group_id: str = ""
    share_group_label: str = ""
    legacy_global_tool_ids: list[str] = Field(default_factory=list, max_length=16)
    exportable: bool = False
    provider_peer_id: str
    provider_service_instance_id: str
    provider_label: str | None = None
    provider_granted_permissions: list[str] | None = None
    provider_available: bool | None = None
    namespace: str
    display_name: str
    aliases: list[str] = Field(default_factory=list)
    description: str = ""
    args_schema: dict[str, Any] = Field(
        default_factory=lambda: {"type": "object", "properties": {}}
    )
    schema: dict[str, Any] = Field(default_factory=lambda: {"type": "object", "properties": {}})
    argument_visibility: dict[str, ToolingArgumentVisibility] = Field(default_factory=dict)
    source_type: Literal["local", "mesh_peer"] = "local"
    source: Literal["core", "plugin", "mcp", "mesh_peer", "unknown"] = "unknown"
    source_id: str | None = None
    trust_tier: ToolingTrustTier = "untrusted"
    capability_class: ToolingCapabilityClass = "read"
    resource_scope: list[str] = Field(default_factory=list)
    execution_location: ToolingExecutionLocation = "local"
    safety_class: ToolingSafetyClass = "standard"
    risk_class: ToolingRiskClass = "standard"
    data_egress: bool = False
    mutating: bool = False
    external: bool = False
    admin: bool = False
    privacy_hints: list[str] = Field(default_factory=list)
    required_permissions: list[str] = Field(default_factory=list)
    confirmation_required: bool = False
    rate_limit_hints: ToolingRateLimitHints | None = None
    provenance: ToolingToolProvenance

    @field_validator("legacy_global_tool_ids")
    @classmethod
    def _bounded_unique_legacy_ids(cls, value: list[str]) -> list[str]:
        normalized = sorted(set(value))
        if any(not item or item != item.strip() or len(item) > 512 for item in normalized):
            raise ValueError("legacy global tool IDs must be non-empty, trimmed, and bounded")
        return normalized


class ToolingGetToolsResponse(IOModel):
    """Response with available tools."""

    tools: list[ToolingToolInfo]
    count: int = Field(ge=0, le=JS_SAFE_INTEGER_MAX)


class ToolingGetToolCatalogRequest(IOModel):
    """Request an aggregate local-plus-remote tool catalog."""

    query: str | None = None
    top_k: int = 100
    include_unavailable: bool = True
    include_blocked_tools: bool = True
    cache_ttl_seconds: float = 10.0
    provider_timeout_seconds: float = 1.5
    caller_permissions: list[str] | None = None


class ToolingCatalogProviderInfo(IOModel):
    """One local or remote Tooling provider considered for catalog fanout."""

    provider_peer_id: str
    provider_service_instance_id: str
    provider_label: str | None = None
    provider_kind: Literal["local", "mesh_peer"] = "mesh_peer"
    eligible: bool = False
    reason_code: str = ""
    reason: str = ""
    cache_status: Literal["local", "hit", "miss", "failed", "blocked"] = "blocked"


class ToolingBlockedToolInfo(IOModel):
    """Tool intentionally omitted from the bindable catalog with an explanation."""

    tool: ToolingToolInfo
    reason_code: str
    reason: str
    missing_permissions: list[str] = Field(default_factory=list)


class ToolingGetToolCatalogResponse(IOModel):
    """Aggregate catalog with bindable tools and blocked provider/tool details."""

    tools: list[ToolingToolInfo] = Field(default_factory=list)
    blocked_tools: list[ToolingBlockedToolInfo] = Field(default_factory=list)
    providers: list[ToolingCatalogProviderInfo] = Field(default_factory=list)
    count: int = 0
    blocked_count: int = 0
    generated_at: str
    cache_ttl_seconds: float = 10.0
    secrets_redacted: bool = True


class ToolingGetToolByNameRequest(IOModel):
    """Request to get a specific tool by name."""

    name: str
    mesh_selector: MeshAddressSelector | None = None


class ToolingGetToolByNameResponse(IOModel):
    """Response with tool details."""

    found: bool
    name: str
    description: str | None = None


class ToolingGetStatsRequest(IOModel):
    """Request to get tooling statistics."""

    pass  # No parameters needed


class ToolingGetStatsResponse(IOModel):
    """Response with tooling statistics."""

    total_tools: int
    mcp_tools_loaded: int
    core_tools: int | None = None
    plugin_tools: int | None = None


class ToolingGetMCPStatusRequest(IOModel):
    """Request to get MCP server status."""

    pass  # No parameters needed


class ToolingGetMCPStatusResponse(IOModel):
    """Response with MCP server status."""

    servers: list[dict[str, Any]]
    total_servers: int
    active_servers: int


class ToolingReloadMCPRequest(IOModel):
    """Request to reload MCP tools."""

    pass  # No parameters needed


class ToolingResourceSelector(IOModel):
    """Explicit resource selector for safety-sensitive tool execution."""

    resource_namespace: str | None = None
    resource_id: str | None = None
    resource_type: str | None = None
    hardware_target: str | None = None
    data_scope: str | None = None

    def has_resource(self) -> bool:
        """Return True when the selector identifies a concrete resource/scope."""

        return bool(
            self.resource_namespace
            or self.resource_id
            or self.resource_type
            or self.hardware_target
            or self.data_scope
        )


class ToolingSharingPolicyRule(IOModel):
    """A scoped Tooling sharing and approval rule.

    Fields left unset act as wildcards. The first matching rule wins.
    """

    rule_id: str
    share: bool = True
    approval_mode: ToolingApprovalMode = "ask_each_time"
    tool_name: str | None = None
    global_tool_id: str | None = None
    execution_location: ToolingExecutionLocation | None = None
    source_type: ToolingSourceClass | None = None
    toolkit_name: str | None = None
    safety_class: ToolingSafetyClass | None = None
    operation_class: ToolingOperationClass | None = None
    resource_namespace: str | None = None
    hardware_target: str | None = None
    data_scope: str | None = None
    caller_peer_id: str | None = None
    caller_principal_id: str | None = None
    caller_device_id: str | None = None
    caller_permissions: list[str] | None = None
    provider_peer_id: str | None = None
    provider_service_instance_id: str | None = None
    route_privacy_class: str | None = None
    token_ttl_seconds: int = Field(default=300, ge=0, le=JS_SAFE_INTEGER_MAX)


class ToolingSharingPolicy(IOModel):
    """Tooling sharing policy visible to admin clients."""

    default_share: bool = True
    default_approval_mode: ToolingApprovalMode = "approve_all_local_safe"
    policy_mode: ToolingPolicyMode = "enforce"
    default_token_ttl_seconds: int = 300
    rules: list[ToolingSharingPolicyRule] = Field(default_factory=list)


class ToolingPolicyDecision(IOModel):
    """Result of evaluating Tooling sharing and approval policy."""

    allowed: bool
    share: bool
    approval_required: bool
    approval_mode: ToolingApprovalMode
    decision_id: str
    policy_rule_id: str | None = None
    reason: str | None = None
    auto_approved_reason: str | None = None
    effective_default: ToolingApprovalMode | None = None
    grant_id: str | None = None
    grant_scope: ToolingApprovalGrantScope | None = None
    token_ttl_seconds: int = Field(default=300, ge=0, le=JS_SAFE_INTEGER_MAX)


class ToolingGetSharingPolicyRequest(IOModel):
    """Request the current Tooling sharing policy."""

    pass


class ToolingGetSharingPolicyResponse(IOModel):
    """Current Tooling sharing policy."""

    policy: ToolingSharingPolicy


class ToolingSetSharingPolicyRequest(IOModel):
    """Replace the Tooling sharing policy."""

    policy: ToolingSharingPolicy
    actor_principal_id: str | None = None
    confirmation_text: str | None = None
    correlation_id: str | None = None


class ToolingSetSharingPolicyResponse(IOModel):
    """Policy update result."""

    ok: bool
    policy: ToolingSharingPolicy
    error: str | None = None
    correlation_id: str | None = None


class ToolingExportPolicy(IOModel):
    """Durable global Tooling export default, independent from approval."""

    default_state: ToolingExportState = "shared"
    revision: int = Field(default=0, ge=0)
    initialized: bool = False
    migrated_from_legacy: bool = False
    updated_at: float | None = None


class ToolingExportRule(IOModel):
    """One global or stable-recipient export override."""

    rule_id: str = Field(min_length=1, max_length=160)
    peer_id: str | None = Field(default=None, min_length=1, max_length=160)
    scope_type: ToolingExportScopeType
    scope_id: str = Field(min_length=1, max_length=1024)
    state: ToolingExportState
    actor_principal_id: str = Field(min_length=1, max_length=256)
    reason: str = Field(min_length=1, max_length=2048)
    created_at: float
    updated_at: float

    @field_validator("peer_id", "scope_id", "actor_principal_id", "reason")
    @classmethod
    def _trimmed_export_authority_value(cls, value: str | None) -> str | None:
        if value is not None and value != value.strip():
            raise ValueError("Tooling export authority values must be trimmed")
        return value


class ToolingMeshKillSwitches(IOModel):
    """Persisted bilateral mesh Tooling switches; enforcement begins in G013."""

    provider_mesh_tooling_enabled: bool = True
    consumer_mesh_tooling_enabled: bool = True
    revision: int = Field(default=0, ge=0)
    updated_at: float | None = None
    enforcement_active: bool = False


class ToolingExportPrerequisiteEvidence(IOModel):
    """Secret-free management evidence for one independent export gate."""

    key: str = Field(min_length=1, max_length=128)
    state: ToolingExportPrerequisiteState
    source: ToolingExportPrerequisiteSource
    reason_code: str = Field(min_length=1, max_length=128)
    required_permissions: list[str] = Field(default_factory=list)
    observed_permissions: list[str] = Field(default_factory=list)


class ToolingExportPrerequisites(IOModel):
    """Explain every independent gate without treating preview as enforcement."""

    local_exportable: bool
    provider_mesh_tooling_enabled: bool = False
    consumer_mesh_tooling_enabled: bool = False
    service_shared: bool | None = None
    catalog_method_shared: bool | None = None
    discovery_method_shared: bool | None = None
    prepare_method_shared: bool | None = None
    execute_method_shared: bool | None = None
    peer_catalog_rbac: bool | None = None
    peer_discovery_rbac: bool | None = None
    peer_prepare_rbac: bool | None = None
    peer_execute_rbac: bool | None = None
    tool_required_permissions_granted: bool | None = None
    enforcement_active: bool = False
    evidence: list[ToolingExportPrerequisiteEvidence] = Field(default_factory=list)


class ToolingExportDecision(IOModel):
    """Effective recipient decision using deterministic five-level precedence."""

    effective_state: ToolingExportState
    inherited_from: ToolingExportDecisionSource
    matched_rule_id: str | None = None
    peer_id: str | None = None
    global_tool_id: str
    share_group_id: str
    exportable: bool
    stale_tool_id: bool = False
    stale_group_id: bool = False
    prerequisites: ToolingExportPrerequisites
    policy_revision: int = Field(ge=0)
    reason_code: str


class ToolingGetToolExportPolicyRequest(IOModel):
    """Read the export policy and optional stable-recipient overlay."""

    peer_id: str | None = Field(default=None, min_length=1, max_length=160)
    include_rules: bool = True
    include_stale: bool = True


class ToolingExportRecipientScope(IOModel):
    """Configured recipient identity, including peers absent from the live registry."""

    peer_id: str = Field(min_length=1, max_length=160)
    display_name: str = Field(min_length=1, max_length=256)
    stale: bool = False
    rule_count: int = Field(ge=1)
    last_rule_updated_at: float


class ToolingGetToolExportPolicyResponse(IOModel):
    """Export authority snapshot; never includes tool arguments or secrets."""

    policy: ToolingExportPolicy
    rules: list[ToolingExportRule] = Field(default_factory=list)
    stale_tool_ids: list[str] = Field(default_factory=list)
    stale_group_ids: list[str] = Field(default_factory=list)
    recipient_scopes: list[ToolingExportRecipientScope] = Field(default_factory=list)
    protocol_tier: ToolingExportProtocolTier = "projection_v1"
    mesh_switches: ToolingMeshKillSwitches = Field(default_factory=ToolingMeshKillSwitches)
    secrets_redacted: bool = True


class ToolingExportMutationRequest(IOModel):
    """Shared optimistic-lock and AdminAction fields for export mutations."""

    state: ToolingExportState
    expected_revision: int = Field(ge=0)
    actor_principal_id: str = Field(min_length=1, max_length=256)
    reason: str = Field(min_length=1, max_length=2048)
    confirmation_text: str
    correlation_id: str | None = Field(default=None, max_length=256)

    @field_validator("actor_principal_id", "reason")
    @classmethod
    def _require_trimmed_nonblank_export_reason(cls, value: str) -> str:
        if not value.strip() or value != value.strip():
            raise ValueError("Tooling export mutation audit values must be trimmed and nonblank")
        return value


class ToolingSetToolExportDefaultRequest(ToolingExportMutationRequest):
    """Change the global export default."""


class ToolingUpsertToolGroupExportPolicyRequest(ToolingExportMutationRequest):
    """Upsert one group override for all peers or one stable peer."""

    share_group_id: str = Field(min_length=1, max_length=160)
    peer_id: str | None = Field(default=None, min_length=1, max_length=160)


class ToolingUpsertToolExportOverrideRequest(ToolingExportMutationRequest):
    """Upsert one canonical-tool override for all peers or one stable peer."""

    global_tool_id: str = Field(min_length=1, max_length=1024)
    peer_id: str | None = Field(default=None, min_length=1, max_length=160)


class ToolingClearToolExportOverrideRequest(IOModel):
    """Delete one exact override so lower precedence becomes visible."""

    scope_type: ToolingExportScopeType
    scope_id: str = Field(min_length=1, max_length=1024)
    peer_id: str | None = Field(default=None, min_length=1, max_length=160)
    expected_revision: int = Field(ge=0)
    actor_principal_id: str = Field(min_length=1, max_length=256)
    reason: str = Field(min_length=1, max_length=2048)
    confirmation_text: str
    correlation_id: str | None = Field(default=None, max_length=256)

    @field_validator("actor_principal_id", "reason")
    @classmethod
    def _require_trimmed_nonblank_clear_reason(cls, value: str) -> str:
        if not value.strip() or value != value.strip():
            raise ValueError("Tooling export mutation audit values must be trimmed and nonblank")
        return value


class ToolingExportMutationResponse(IOModel):
    """Common optimistic export mutation result."""

    ok: bool
    policy: ToolingExportPolicy | None = None
    rule: ToolingExportRule | None = None
    cleared: bool = False
    changed: bool = False
    audit_id: str | None = None
    previous_revision: int = Field(ge=0)
    revision: int = Field(ge=0)
    error: str | None = None
    correlation_id: str | None = None


class ToolingSetToolExportDefaultResponse(ToolingExportMutationResponse):
    """Global-default mutation result."""


class ToolingUpsertToolGroupExportPolicyResponse(ToolingExportMutationResponse):
    """Group-rule mutation result."""


class ToolingUpsertToolExportOverrideResponse(ToolingExportMutationResponse):
    """Exact-tool mutation result."""


class ToolingClearToolExportOverrideResponse(ToolingExportMutationResponse):
    """Clear-rule mutation result."""


class ToolingPreviewToolExportDecisionRequest(IOModel):
    """Preview one recipient decision without writing or incrementing revision."""

    global_tool_id: str = Field(min_length=1, max_length=1024)
    share_group_id: str | None = Field(default=None, min_length=1, max_length=160)
    peer_id: str | None = Field(default=None, min_length=1, max_length=160)


class ToolingPreviewToolExportDecisionResponse(IOModel):
    """Read-only effective export decision."""

    decision: ToolingExportDecision


class ToolingExecuteToolRequest(IOModel):
    """Request to execute a tool."""

    tool_name: str
    arguments: dict[str, Any]
    expected_args_schema_hash: str | None = None
    mesh_selector: MeshAddressSelector | None = None
    resource_selector: ToolingResourceSelector | None = None
    confirmed: bool = False
    approval_token: str | None = None
    dry_run: bool = False
    correlation_id: str | None = None
    caller_peer_id: str | None = None
    caller_principal_id: str | None = None
    caller_device_id: str | None = None
    caller_permissions: list[str] | None = None
    schedule_id: str | None = None
    scheduled_action_hash: str | None = None


class ToolingExecuteToolResponse(IOModel):
    """Response from tool execution."""

    ok: bool
    data: Any | None = None
    error: str | None = None
    status: Literal["success", "denied", "not_found", "failed", "dry_run"] | None = None
    error_code: str | None = None
    correlation_id: str | None = None
    provider_peer_id: str | None = None
    global_tool_id: str | None = None
    policy_decision_id: str | None = None
    display_args_preview: dict[str, Any] = Field(default_factory=dict)
    args_hash: str | None = None


class ToolingPrepareExecutionRequest(ToolingExecuteToolRequest):
    """Request a policy decision and argument binding before execution."""

    pass


class ToolingPrepareExecutionResponse(IOModel):
    """Execution preparation details."""

    ok: bool
    policy_decision: ToolingPolicyDecision
    args_hash: str
    resource_selector_hash: str
    route_decision_id: str
    correlation_id: str
    provider_peer_id: str
    provider_service_instance_id: str
    global_tool_id: str
    local_tool_name: str
    args_schema_hash: str | None = None
    source: Literal["core", "plugin", "mcp", "mesh_peer", "unknown"] = "unknown"
    source_id: str | None = None
    trust_tier: ToolingTrustTier = "untrusted"
    capability_class: ToolingCapabilityClass = "read"
    resource_scope: list[str] = Field(default_factory=list)
    display_args_preview: dict[str, Any] = Field(default_factory=dict)
    argument_visibility: dict[str, ToolingArgumentVisibility] = Field(default_factory=dict)
    secrets_redacted: bool = True


class ToolingTestSharingPolicyRequest(ToolingPrepareExecutionRequest):
    """Evaluate sharing policy without creating an approval request."""

    pass


class ToolingTestSharingPolicyResponse(ToolingPrepareExecutionResponse):
    """Sharing-policy evaluation response."""

    pass


class ToolingRequestApprovalRequest(ToolingPrepareExecutionRequest):
    """Create an approval request for a prepared execution."""

    requested_by_principal_id: str | None = None


class ToolingRequestApprovalResponse(IOModel):
    """Approval request state."""

    ok: bool
    approval_request_id: str | None = None
    policy_decision: ToolingPolicyDecision
    expires_at: float | None = None
    correlation_id: str
    error: str | None = None


class ToolingConfirmExecutionRequest(IOModel):
    """Approve an execution request and receive a bound approval token."""

    approval_request_id: str
    approver_principal_id: str
    approve: bool = True
    grant_scope: ToolingApprovalGrantScope = "once"
    expires_at: float | None = None
    include_future_tools: bool = False
    reason: str | None = None
    correlation_id: str | None = None


class ToolingConfirmExecutionResponse(IOModel):
    """Execution confirmation result."""

    ok: bool
    approval_token: str | None = None
    expires_at: float | None = None
    policy_decision_id: str | None = None
    correlation_id: str | None = None
    error: str | None = None


class ToolingApprovalGrant(IOModel):
    """Durable Tooling approval/trust/capability grant."""

    grant_id: str
    grant_scope: ToolingApprovalGrantScope
    grant_type: Literal["approval", "trust", "capability", "scheduled_execution"] = "approval"
    active: bool = True
    principal_id: str | None = None
    caller_device_id: str | None = None
    caller_peer_id: str | None = None
    provider_peer_id: str | None = None
    provider_service_instance_id: str | None = None
    global_tool_id: str | None = None
    local_tool_name: str | None = None
    args_hash: str | None = None
    resource_selector_hash: str | None = None
    route_decision_id: str | None = None
    schedule_id: str | None = None
    trust_tier: ToolingTrustTier | None = None
    capability_class: ToolingCapabilityClass | None = None
    resource_scope: list[str] = Field(default_factory=list)
    include_future_tools: bool = False
    created_by: str | None = None
    created_at: float
    expires_at: float | None = None
    revoked_at: float | None = None
    reason: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class ToolingListApprovalGrantsRequest(IOModel):
    """List durable Tooling grants."""

    principal_id: str | None = None
    provider_peer_id: str | None = None
    global_tool_id: str | None = None
    include_revoked: bool = False


class ToolingListApprovalGrantsResponse(IOModel):
    """Durable Tooling grants."""

    grants: list[ToolingApprovalGrant] = Field(default_factory=list)
    count: int = 0


class ToolingCreateApprovalGrantRequest(IOModel):
    """Create a durable Tooling approval/trust/capability grant."""

    grant_scope: ToolingApprovalGrantScope
    grant_type: Literal["approval", "trust", "capability", "scheduled_execution"] = "approval"
    principal_id: str | None = None
    caller_device_id: str | None = None
    caller_peer_id: str | None = None
    provider_peer_id: str | None = None
    provider_service_instance_id: str | None = None
    global_tool_id: str | None = None
    local_tool_name: str | None = None
    args_hash: str | None = None
    resource_selector_hash: str | None = None
    route_decision_id: str | None = None
    schedule_id: str | None = None
    trust_tier: ToolingTrustTier | None = None
    capability_class: ToolingCapabilityClass | None = None
    resource_scope: list[str] = Field(default_factory=list)
    include_future_tools: bool = False
    created_by: str | None = None
    expires_at: float | None = None
    reason: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    correlation_id: str | None = None


class ToolingCreateApprovalGrantResponse(IOModel):
    """Created durable Tooling grant."""

    ok: bool
    grant: ToolingApprovalGrant | None = None
    error: str | None = None
    correlation_id: str | None = None


class ToolingRevokeApprovalGrantRequest(IOModel):
    """Revoke a durable Tooling grant."""

    grant_id: str
    revoked_by: str | None = None
    reason: str | None = None
    correlation_id: str | None = None


class ToolingRevokeApprovalGrantResponse(IOModel):
    """Grant revocation result."""

    ok: bool
    grant_id: str
    error: str | None = None
    correlation_id: str | None = None


class ToolingEvaluateApprovalGrantRequest(ToolingPrepareExecutionRequest):
    """Evaluate durable grants for an exact Tooling execution."""

    schedule_id: str | None = None
    scheduled_action_hash: str | None = None
    grant_scope: ToolingApprovalGrantScope | None = None


class ToolingEvaluateApprovalGrantResponse(IOModel):
    """Durable grant evaluation response."""

    ok: bool
    grant: ToolingApprovalGrant | None = None
    policy_decision: ToolingPolicyDecision | None = None
    reason: str | None = None
    correlation_id: str | None = None


ToolingSourceStatus = Literal[
    "active",
    "blocked",
    "stale",
    "removed",
    "unshared",
    "permission_blocked",
    "provider_unavailable",
    "schema_changed",
    "protocol_unsupported",
    "unknown",
]
ToolingOnboardingCapabilityStatus = Literal["available", "disabled", "unsupported", "unknown"]


class ToolingGetPolicySummaryRequest(IOModel):
    """Request an operator-facing Tooling policy summary."""

    include_counts: bool = True


class ToolingGetPolicySummaryResponse(IOModel):
    """Operator-facing Tooling policy and queue counters."""

    policy: ToolingSharingPolicy
    policy_mode: ToolingPolicyMode
    default_approval_mode: ToolingApprovalMode
    default_share: bool
    dry_run_only: bool = False
    deny_all: bool = False
    unrestricted_except_blocked: bool = False
    active_grant_count: int = 0
    pending_approval_count: int = 0
    blocked_source_count: int = 0
    blocked_tool_count: int = 0
    source_count: int = 0
    tool_count: int = 0
    last_policy_change_actor: str | None = None
    last_policy_change_at: float | None = None
    secrets_redacted: bool = True


class ToolingListToolSourcesRequest(IOModel):
    """List grouped Tooling catalog sources for management UI."""

    include_blocked_tools: bool = True
    include_counts: bool = True
    caller_permissions: list[str] | None = None


class ToolingToolSourceSummary(IOModel):
    """One grouped Tooling source row."""

    source_id: str
    source: Literal["core", "plugin", "mcp", "mesh_peer", "unknown", "blocked"]
    display_name: str
    provider_peer_id: str = "local"
    provider_service_instance_id: str = "local:Tooling"
    provider_label: str | None = None
    provider_kind: Literal["local", "mesh_peer"] = "local"
    trust_tier: ToolingTrustTier = "untrusted"
    configured_trust_tier: ToolingTrustTier | None = None
    status: ToolingSourceStatus = "active"
    tool_count: int = 0
    retained_tool_count: int = 0
    inactive_tool_count: int = 0
    availability_counts: dict[str, int] = Field(default_factory=dict)
    blocked_tool_count: int = 0
    pending_approval_count: int = 0
    active_grant_count: int = 0
    stale_grant_count: int = 0
    unreviewed_tool_count: int = 0
    include_future_tools_grants: int = 0
    cache_status: Literal["local", "hit", "miss", "failed", "blocked", "unknown"] = "unknown"
    catalog_epoch: int | None = None
    catalog_hash: str | None = None
    generated_at: str | None = None
    updated_at: float | None = None
    shared_by_policy: bool = True
    removed_at: float | None = None
    reason_code: str | None = None
    reason: str | None = None


class ToolingListToolSourcesResponse(IOModel):
    """Grouped Tooling catalog sources."""

    sources: list[ToolingToolSourceSummary] = Field(default_factory=list)
    count: int = 0
    generated_at: str
    secrets_redacted: bool = True


class ToolingSourceSummary(IOModel):
    """Compatibility source summary for source-first Tooling clients."""

    source_id: str
    source_type: Literal["core", "plugin", "mcp", "mesh_peer", "unknown", "blocked"]
    display_name: str
    trust_tier: ToolingTrustTier = "untrusted"
    configured_trust_tier: ToolingTrustTier | None = None
    tool_count: int = 0
    blocked_count: int = 0
    new_child_count: int = 0
    stale_grant_count: int = 0
    catalog_cache_state: Literal["local", "fresh", "stale", "removed", "unshared", "unknown"] = (
        "unknown"
    )
    catalog_epoch: int | None = None
    catalog_hash: str | None = None
    last_announcement_at: str | None = None
    include_future_tools: bool = False
    secrets_redacted: bool = True


class ToolingToolPolicyOverride(IOModel):
    """Per-tool policy override shown by the Tooling management page."""

    global_tool_id: str | None = None
    local_tool_name: str | None = None
    trust_tier: ToolingTrustTier
    include_future_tools: bool = False
    reason: str | None = None
    expected_schema_hash: str | None = None
    updated_by: str | None = None
    updated_at: float | None = None
    secrets_redacted: bool = True


class ToolingSchedulerDependency(IOModel):
    """Scheduled Tooling action dependency status."""

    schedule_id: str
    tool_name: str
    global_tool_id: str | None = None
    grant_id: str | None = None
    status: Literal["ok", "missing_grant", "revoked", "stale", "blocked", "unknown"] = "unknown"
    reason: str | None = None
    secrets_redacted: bool = True


class ToolingSetPolicyModeRequest(IOModel):
    """Set global Tooling policy mode with audit context."""

    policy_mode: ToolingPolicyMode
    actor_principal_id: str
    reason: str
    confirmation_text: str | None = None
    correlation_id: str | None = None


class ToolingSetPolicyModeResponse(IOModel):
    """Result of setting global Tooling policy mode."""

    ok: bool
    policy: ToolingSharingPolicy | None = None
    error: str | None = None
    correlation_id: str | None = None


class ToolingUpsertSourcePolicyRequest(IOModel):
    """Create/update source trust policy with audit context."""

    source_id: str
    trust_tier: ToolingTrustTier
    actor_principal_id: str
    reason: str
    include_future_tools: bool = False
    provider_peer_id: str | None = None
    provider_service_instance_id: str | None = None
    correlation_id: str | None = None


class ToolingUpsertSourcePolicyResponse(IOModel):
    """Result of creating/updating source trust policy."""

    ok: bool
    grant: ToolingApprovalGrant | None = None
    error: str | None = None
    correlation_id: str | None = None


class ToolingClearSourcePolicyRequest(IOModel):
    """Clear an explicit source trust policy so it inherits the global default."""

    source_id: str
    actor_principal_id: str
    reason: str
    correlation_id: str | None = None


class ToolingClearSourcePolicyResponse(IOModel):
    """Result of clearing an explicit source trust policy."""

    ok: bool
    cleared: bool = False
    revoked_grant_ids: list[str] = Field(default_factory=list)
    error: str | None = None
    correlation_id: str | None = None


class ToolingUpsertToolPolicyOverrideRequest(IOModel):
    """Create/update per-tool trust policy with audit context."""

    global_tool_id: str | None = None
    local_tool_name: str | None = None
    provider_peer_id: str | None = None
    provider_service_instance_id: str | None = None
    trust_tier: ToolingTrustTier
    actor_principal_id: str
    reason: str
    expected_schema_hash: str | None = None
    include_future_tools: bool = False
    correlation_id: str | None = None


class ToolingUpsertToolPolicyOverrideResponse(IOModel):
    """Result of creating/updating per-tool policy."""

    ok: bool
    grant: ToolingApprovalGrant | None = None
    error: str | None = None
    correlation_id: str | None = None


class ToolingClearToolPolicyOverrideRequest(IOModel):
    """Clear an explicit per-tool trust policy so it inherits its source policy."""

    global_tool_id: str | None = None
    local_tool_name: str | None = None
    actor_principal_id: str
    reason: str
    correlation_id: str | None = None

    @model_validator(mode="after")
    def validate_tool_identity(self) -> "ToolingClearToolPolicyOverrideRequest":
        if not self.global_tool_id and not self.local_tool_name:
            raise ValueError("global_tool_id or local_tool_name is required")
        return self


class ToolingClearToolPolicyOverrideResponse(IOModel):
    """Result of clearing an explicit per-tool trust policy."""

    ok: bool
    cleared: bool = False
    revoked_grant_ids: list[str] = Field(default_factory=list)
    error: str | None = None
    correlation_id: str | None = None


class ToolingTestMCPSourceRequest(IOModel):
    """Validate an MCP source without storing raw secrets."""

    actor_principal_id: str
    source_id: str
    transport: Literal["stdio", "streamable_http", "sse"] = "stdio"
    command: str | None = None
    args: list[str] = Field(default_factory=list)
    url: str | None = None
    headers: dict[str, SecretStr] = Field(default_factory=dict)
    env: dict[str, SecretStr] = Field(default_factory=dict)
    reason: str
    correlation_id: str | None = None


class ToolingTestMCPSourceResponse(IOModel):
    """MCP source validation result."""

    ok: bool
    source_id: str
    message: str | None = None
    tool_count: int = 0
    error: str | None = None
    secrets_redacted: bool = True


class ToolingCreateMCPSourceRequest(ToolingTestMCPSourceRequest):
    """Create an MCP source after validation."""

    trust_tier: ToolingTrustTier = "untrusted"
    include_future_tools: bool = False


class ToolingCreateMCPSourceResponse(ToolingTestMCPSourceResponse):
    """MCP source creation result."""

    created: bool = False


class ToolingTestPluginSourceRequest(IOModel):
    """Validate a plugin source before enabling it."""

    actor_principal_id: str
    source_id: str
    package: str
    plugin_name: str | None = None
    version: str | None = None
    reason: str
    correlation_id: str | None = None


class ToolingTestPluginSourceResponse(IOModel):
    """Plugin source validation result."""

    ok: bool
    source_id: str
    message: str | None = None
    error: str | None = None
    secrets_redacted: bool = True


class ToolingCreatePluginSourceRequest(ToolingTestPluginSourceRequest):
    """Create or enable a plugin source."""

    trust_tier: ToolingTrustTier = "untrusted"
    include_future_tools: bool = False


class ToolingCreatePluginSourceResponse(ToolingTestPluginSourceResponse):
    """Plugin source creation result."""

    created: bool = False


class ToolingGetToolSourceDetailRequest(IOModel):
    """Request details for one Tooling source row."""

    source_id: str
    include_tools: bool = True
    include_grants: bool = True
    include_pending_approvals: bool = True
    include_blocked_tools: bool = True
    caller_permissions: list[str] | None = None


class ToolingPendingApproval(IOModel):
    """Redacted pending Tooling approval request for management UI."""

    approval_request_id: str
    requested_by_principal_id: str | None = None
    caller_peer_id: str | None = None
    caller_device_id: str | None = None
    provider_peer_id: str
    provider_service_instance_id: str
    global_tool_id: str
    local_tool_name: str
    source: Literal["core", "plugin", "mcp", "mesh_peer", "unknown"] = "unknown"
    source_id: str | None = None
    trust_tier: ToolingTrustTier = "untrusted"
    capability_class: ToolingCapabilityClass = "read"
    approval_mode: ToolingApprovalMode
    policy_decision_id: str
    correlation_id: str
    args_hash: str
    display_args_preview: dict[str, Any] = Field(default_factory=dict)
    resource_selector_hash: str
    created_at: float
    expires_at: float
    used: bool = False
    expired: bool = False
    secrets_redacted: bool = True


class ToolingListPendingApprovalsRequest(IOModel):
    """List redacted pending Tooling approval requests."""

    principal_id: str | None = None
    provider_peer_id: str | None = None
    global_tool_id: str | None = None
    include_used: bool = False
    include_expired: bool = False
    limit: int = 100


class ToolingListPendingApprovalsResponse(IOModel):
    """Redacted pending Tooling approval queue."""

    approvals: list[ToolingPendingApproval] = Field(default_factory=list)
    count: int = 0
    secrets_redacted: bool = True


class ToolingGetToolSourceDetailResponse(IOModel):
    """Detailed Tooling source read model."""

    source: ToolingToolSourceSummary | None = None
    tools: list[ToolingToolInfo] = Field(default_factory=list)
    blocked_tools: list[ToolingBlockedToolInfo] = Field(default_factory=list)
    retained_tools: list["ToolingRetainedRemoteTool"] = Field(default_factory=list)
    grants: list[ToolingApprovalGrant] = Field(default_factory=list)
    pending_approvals: list[ToolingPendingApproval] = Field(default_factory=list)
    policy_rules: list[ToolingSharingPolicyRule] = Field(default_factory=list)
    found: bool = False
    secrets_redacted: bool = True


class ToolingRetainedRemoteTool(IOModel):
    """Management-only retained remote definition; never assistant-bindable by itself."""

    peer_id: str
    provider_id: str
    provider_label: str | None = None
    service_instance_id: str
    source_id: str
    global_tool_id: str
    local_tool_name: str
    display_name: str
    source: Literal["core", "plugin", "mcp", "mesh_peer", "unknown"] = "unknown"
    retained_source_id: str | None = None
    share_group_id: str | None = None
    share_group_label: str | None = None
    provider_tool_id: str | None = None
    retained_availability: ToolingRemoteAvailability
    effective_availability: ToolingRemoteAvailability
    reason_code: str
    missing_permissions: list[str] = Field(default_factory=list)
    provider_reason_code: str | None = None
    schema_hash: str
    accepted_schema_hash: str
    review_required: bool = False
    projection_revision: str | None = None
    current_generation: int = Field(ge=0)
    active_generation: int | None = Field(default=None, ge=0)
    first_seen_at: float
    last_seen_at: float
    updated_at: float
    compacted_at: float | None = None
    approval_grant_ids: list[str] = Field(default_factory=list)
    policy_rule_ids: list[str] = Field(default_factory=list)
    tool: ToolingToolInfo | None = None
    secrets_redacted: bool = True


class ToolingAcceptRemoteToolSchemaRequest(IOModel):
    """Accept one exact retained schema after explicit operator review."""

    peer_id: str = Field(min_length=1, max_length=160)
    provider_id: str = Field(min_length=1, max_length=256)
    global_tool_id: str = Field(min_length=1, max_length=1024)
    expected_projection_revision: str = Field(min_length=1, max_length=256)
    expected_schema_hash: str = Field(min_length=64, max_length=64)
    actor_principal_id: str = Field(min_length=1, max_length=256)
    reason: str = Field(min_length=1, max_length=2048)
    correlation_id: str | None = Field(default=None, max_length=256)


class ToolingAcceptRemoteToolSchemaResponse(IOModel):
    ok: bool
    changed: bool = False
    retained_tool: ToolingRetainedRemoteTool | None = None
    error: str | None = None
    correlation_id: str | None = None


class ToolingListPolicyAuditEventsRequest(IOModel):
    """List redacted Tooling policy/audit events."""

    limit: int = 50
    offset: int = 0
    principal_id: str | None = None
    event: str | None = None
    correlation_id: str | None = None
    provider_peer_id: str | None = None
    global_tool_id: str | None = None


class ToolingPolicyAuditEvent(IOModel):
    """Redacted Tooling audit event row."""

    event: str
    principal_id: str | None = None
    details: dict[str, Any] = Field(default_factory=dict)
    created_at: str | float | None = None
    correlation_id: str | None = None
    policy_decision_id: str | None = None
    provider_peer_id: str | None = None
    global_tool_id: str | None = None
    secrets_redacted: bool = True


class ToolingListPolicyAuditEventsResponse(IOModel):
    """Redacted Tooling audit/history events."""

    events: list[ToolingPolicyAuditEvent] = Field(default_factory=list)
    total: int = 0
    secrets_redacted: bool = True


class ToolingGetOnboardingStatusRequest(IOModel):
    """Request Tooling source onboarding status."""

    include_mcp_servers: bool = True
    include_plugin_sources: bool = True


class ToolingOnboardingCapability(IOModel):
    """One source onboarding capability/status row."""

    source: Literal["mcp", "plugin", "mesh_peer"]
    status: ToolingOnboardingCapabilityStatus = "unknown"
    available: bool = False
    configured_count: int = 0
    active_count: int = 0
    message: str | None = None
    items: list[dict[str, Any]] = Field(default_factory=list)
    secrets_redacted: bool = True


class ToolingGetOnboardingStatusResponse(IOModel):
    """Tooling onboarding status for MCP/plugin/mesh sources."""

    capabilities: list[ToolingOnboardingCapability] = Field(default_factory=list)
    secrets_redacted: bool = True


class ToolingRemoteCatalogAnnounced(IOModel):
    """Full negotiated remote Tooling catalog snapshot."""

    peer_id: str
    service_instance_id: str
    provider_id: str
    catalog_epoch: int
    generated_at: str
    full_schema_hash: str
    tools: list[ToolingToolInfo] = Field(default_factory=list)
    shared_by_policy: bool = True
    granted_permissions: list[str] | None = None
    provider_available: bool | None = None
    supported_protocol_tiers: list[ToolingExportProtocolTier] = Field(
        default_factory=lambda: ["legacy_unsupported"]
    )
    selected_protocol_tier: ToolingExportProtocolTier = "legacy_unsupported"
    export_policy_revision: int | None = Field(default=None, ge=0)


class ToolingRemoteCatalogDeltaAnnounced(IOModel):
    """Delta update for a negotiated remote Tooling catalog."""

    peer_id: str
    service_instance_id: str
    provider_id: str
    catalog_epoch: int
    generated_at: str
    upserted_tools: list[ToolingToolInfo] = Field(default_factory=list)
    removed_global_tool_ids: list[str] = Field(default_factory=list)
    full_schema_hash: str | None = None
    shared_by_policy: bool | None = None
    granted_permissions: list[str] | None = None
    provider_available: bool | None = None
    supported_protocol_tiers: list[ToolingExportProtocolTier] = Field(
        default_factory=lambda: ["legacy_unsupported"]
    )
    selected_protocol_tier: ToolingExportProtocolTier = "legacy_unsupported"
    export_policy_revision: int | None = Field(default=None, ge=0)


class ToolingRemoteCatalogRemoved(IOModel):
    """Mark a negotiated remote Tooling catalog unavailable/tombstoned."""

    peer_id: str
    service_instance_id: str | None = None
    provider_id: str | None = None
    reason: str | None = None


class ToolingRemoteCatalogRefreshRequested(IOModel):
    """Request a peer to re-announce its Tooling catalog."""

    peer_id: str | None = None
    reason: str | None = None


class ToolingProjectionAuthorityRevision(IOModel):
    """Every authority dimension that makes one recipient projection current."""

    catalog_revision: int = Field(ge=0, le=JS_SAFE_INTEGER_MAX)
    export_policy_revision: int = Field(ge=0, le=JS_SAFE_INTEGER_MAX)
    auth_grant_revision: int = Field(ge=0, le=JS_SAFE_INTEGER_MAX)
    manifest_revision: int = Field(ge=0, le=JS_SAFE_INTEGER_MAX)
    switch_revision: int = Field(ge=0, le=JS_SAFE_INTEGER_MAX)
    protocol_revision: int = Field(default=1, ge=1, le=JS_SAFE_INTEGER_MAX)


class ToolingGetExportCatalogRequest(IOModel):
    """Authenticated recipient projection request.

    Recipient identity is deliberately absent: the RPC envelope is the only
    authority.  The last committed values are refresh hints, never selectors.
    """

    protocol_tier: Literal["projection_v1"] = "projection_v1"
    page_size: int = Field(default=100, ge=1, le=256)
    cursor: str | None = Field(default=None, min_length=1, max_length=4096)
    last_projection_revision: str | None = Field(default=None, max_length=256)
    last_projection_digest: str | None = Field(default=None, max_length=128)


class ToolingProjectionRetirement(IOModel):
    """Bounded state for a tool previously exposed to this exact recipient."""

    global_tool_id: str = Field(min_length=1, max_length=1024)
    availability: Literal["unshared", "permission_blocked", "removed", "stale"]
    reason_code: str = Field(min_length=1, max_length=128)
    last_schema_hash: str | None = Field(default=None, max_length=128)


class ToolingProjectionBlockedTool(IOModel):
    """Management-only definition excluded from the recipient's bindable catalog."""

    tool: ToolingToolInfo
    reason_code: Literal["recipient_missing_tool_permissions"]
    missing_permissions: list[str] = Field(default_factory=list)


class ToolingGetExportCatalogResponse(IOModel):
    """One non-bindable page of a recipient-specific full projection."""

    ok: bool = True
    reason_code: str | None = Field(default=None, max_length=128)
    provider_peer_id: str = Field(min_length=1, max_length=160)
    service_instance_id: str = Field(min_length=1, max_length=256)
    selected_protocol_tier: Literal["projection_v1"] = "projection_v1"
    authority_revision: ToolingProjectionAuthorityRevision
    projection_revision: str = Field(min_length=1, max_length=256)
    projection_digest: str = Field(min_length=1, max_length=128)
    page_index: int = Field(ge=0, le=JS_SAFE_INTEGER_MAX)
    page_size: int = Field(ge=1, le=256)
    page_hash: str = Field(min_length=1, max_length=128)
    tools: list[ToolingToolInfo] = Field(default_factory=list, max_length=256)
    blocked_tools: list[ToolingProjectionBlockedTool] = Field(default_factory=list, max_length=256)
    retirements: list[ToolingProjectionRetirement] = Field(default_factory=list, max_length=256)
    next_cursor: str | None = Field(default=None, min_length=1, max_length=4096)
    complete: bool = False
    total_count: int | None = Field(default=None, ge=0, le=JS_SAFE_INTEGER_MAX)
    final_checksum: str | None = Field(default=None, min_length=1, max_length=128)

    @field_validator("projection_digest", "page_hash", "final_checksum")
    @classmethod
    def _lowercase_digest(cls, value: str | None) -> str | None:
        if value is not None and (value != value.lower() or len(value) != 64):
            raise ValueError("projection hashes must be 64 lowercase hexadecimal characters")
        if value is not None and any(ch not in "0123456789abcdef" for ch in value):
            raise ValueError("projection hashes must be lowercase hexadecimal")
        return value

    @field_validator("next_cursor")
    @classmethod
    def _trimmed_cursor(cls, value: str | None) -> str | None:
        if value is not None and value != value.strip():
            raise ValueError("cursor must be trimmed")
        return value

    @field_validator("final_checksum")
    @classmethod
    def _final_checksum_only_on_complete(cls, value: str | None, info: Any) -> str | None:
        # Cross-field completeness is revalidated by the transactional DB
        # store; this validator prevents a checksum on an explicitly partial
        # page while preserving Pydantic field-order compatibility.
        if value is not None and info.data.get("complete") is False:
            raise ValueError("partial pages cannot carry final_checksum")
        return value

    @model_validator(mode="after")
    def _validate_page_termination(self) -> "ToolingGetExportCatalogResponse":
        if self.complete:
            if (
                self.next_cursor is not None
                or self.total_count is None
                or self.final_checksum is None
            ):
                raise ValueError(
                    "complete projection page requires total_count/final_checksum and no cursor"
                )
        elif (
            self.next_cursor is None
            or self.total_count is not None
            or self.final_checksum is not None
        ):
            raise ValueError(
                "partial projection page requires next_cursor and no final count/checksum"
            )
        return self


class ToolingProjectionInvalidated(IOModel):
    """Metadata-only targeted refresh hint; it never reveals catalog members."""

    provider_peer_id: str = Field(min_length=1, max_length=160)
    service_instance_id: str = Field(min_length=1, max_length=256)
    authority_revision: ToolingProjectionAuthorityRevision
    reason_code: str = Field(min_length=1, max_length=128)
    correlation_id: str = Field(min_length=1, max_length=256)
    affected_peer_ids: list[str] | None = Field(default=None, max_length=1024)


class ToolingProjectionSyncRequested(IOModel):
    """Local Gateway-to-Tooling request bound to an authenticated provider."""

    provider_peer_id: str = Field(min_length=1, max_length=160)
    service_instance_id: str = Field(min_length=1, max_length=256)
    reason_code: str = Field(min_length=1, max_length=128)
    force_full_snapshot: bool = True


class ToolingMeshProjectionReadiness(IOModel):
    """Concrete Tooling-side evidence consumed by the activation coordinator."""

    projection_transport: bool
    normalized_catalog: bool
    consumer_binding: bool
    provider_discovery: bool
    prepare_enforcement: bool
    execute_enforcement: bool
    typed_exposure_ledger: bool = False
    execution_rpc_evidence: bool = False
    exact_method_set: bool = False
    mutation_invalidation: bool = False
    conditional_legacy_retirement: bool = False
    legacy_guard_active: bool
    durable_active: bool
    durable_revision: int = Field(ge=0)

    @property
    def ready(self) -> bool:
        return all(
            (
                self.projection_transport,
                self.normalized_catalog,
                self.consumer_binding,
                self.provider_discovery,
                self.prepare_enforcement,
                self.execute_enforcement,
                self.typed_exposure_ledger,
                self.execution_rpc_evidence,
                self.exact_method_set,
                self.mutation_invalidation,
                self.conditional_legacy_retirement,
                self.legacy_guard_active or self.durable_active,
            )
        )


class ToolingMeshEnforcementActivated(IOModel):
    """Coordinator hint; Tooling still re-reads the durable CAS state."""

    revision: int = Field(ge=1)


class ToolingToolsInitializedEvent(IOModel):
    """Event emitted when tools are initialized."""

    total_tools: int
    mcp_tools_loaded: int


class ToolingToolsReloadedEvent(IOModel):
    """Event emitted when tools are reloaded."""

    total_tools: int
