"""Tooling service contract models."""

from typing import Any, Literal

from pydantic import Field, SecretStr

from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.registry import IOModel


# Module identifier
class ToolingModule:
    """Module identifier for Tooling service."""

    NAME = "Tooling"


# Method identifiers
class ToolingMethods:
    """Full method identifiers for Tooling service."""

    GET_TOOLS = f"{ToolingModule.NAME}.GetTools"
    GET_TOOL_CATALOG = f"{ToolingModule.NAME}.GetToolCatalog"
    GET_TOOL_BY_NAME = f"{ToolingModule.NAME}.GetToolByName"
    GET_STATS = f"{ToolingModule.NAME}.GetStats"
    GET_MCP_STATUS = f"{ToolingModule.NAME}.GetMCPStatus"
    GET_SHARING_POLICY = f"{ToolingModule.NAME}.GetSharingPolicy"
    SET_SHARING_POLICY = f"{ToolingModule.NAME}.SetSharingPolicy"
    TEST_SHARING_POLICY = f"{ToolingModule.NAME}.TestSharingPolicy"
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
    SET_POLICY_MODE = f"{ToolingModule.NAME}.SetPolicyMode"
    UPSERT_SOURCE_POLICY = f"{ToolingModule.NAME}.UpsertSourcePolicy"
    UPSERT_TOOL_POLICY_OVERRIDE = f"{ToolingModule.NAME}.UpsertToolPolicyOverride"
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


class ToolingGetToolsRequest(IOModel):
    """Request to get available tools."""

    query: str | None = None
    top_k: int = 100
    mesh_selector: MeshAddressSelector | None = None


class ToolingRateLimitHints(IOModel):
    """Optional rate-limit hints for a discovered tool provider."""

    max_calls: int | None = None
    window_seconds: int | None = None
    policy: str | None = None


class ToolingToolProvenance(IOModel):
    """Provenance carried with a discovered tool."""

    provider_peer_id: str
    provider_service_instance_id: str
    provider_kind: Literal["local", "mesh_peer"] = "local"
    source: Literal["core", "plugin", "mcp", "unknown"] = "unknown"
    advertised_name: str


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
    provider_peer_id: str
    provider_service_instance_id: str
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


class ToolingGetToolsResponse(IOModel):
    """Response with available tools."""

    tools: list[ToolingToolInfo]
    count: int


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
    token_ttl_seconds: int = 300


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
    token_ttl_seconds: int = 300


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


ToolingSourceStatus = Literal["active", "blocked", "stale", "removed", "unshared", "unknown"]
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
    provider_kind: Literal["local", "mesh_peer"] = "local"
    trust_tier: ToolingTrustTier = "untrusted"
    status: ToolingSourceStatus = "active"
    tool_count: int = 0
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


class ToolingUpsertToolPolicyOverrideRequest(IOModel):
    """Create/update per-tool trust policy with audit context."""

    global_tool_id: str | None = None
    local_tool_name: str | None = None
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
    grants: list[ToolingApprovalGrant] = Field(default_factory=list)
    pending_approvals: list[ToolingPendingApproval] = Field(default_factory=list)
    policy_rules: list[ToolingSharingPolicyRule] = Field(default_factory=list)
    found: bool = False
    secrets_redacted: bool = True


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


class ToolingToolsInitializedEvent(IOModel):
    """Event emitted when tools are initialized."""

    total_tools: int
    mcp_tools_loaded: int


class ToolingToolsReloadedEvent(IOModel):
    """Event emitted when tools are reloaded."""

    total_tools: int
