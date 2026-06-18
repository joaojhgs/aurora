"""Tooling service contract models."""

from typing import Any, Literal

from pydantic import Field

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
    GET_TOOL_BY_NAME = f"{ToolingModule.NAME}.GetToolByName"
    GET_STATS = f"{ToolingModule.NAME}.GetStats"
    GET_MCP_STATUS = f"{ToolingModule.NAME}.GetMCPStatus"
    GET_SHARING_POLICY = f"{ToolingModule.NAME}.GetSharingPolicy"
    SET_SHARING_POLICY = f"{ToolingModule.NAME}.SetSharingPolicy"
    TEST_SHARING_POLICY = f"{ToolingModule.NAME}.TestSharingPolicy"
    PREPARE_EXECUTION = f"{ToolingModule.NAME}.PrepareExecution"
    REQUEST_APPROVAL = f"{ToolingModule.NAME}.RequestApproval"
    CONFIRM_EXECUTION = f"{ToolingModule.NAME}.ConfirmExecution"
    EXECUTE_TOOL = f"{ToolingModule.NAME}.ExecuteTool"
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

ToolingSourceClass = Literal["core", "plugin", "mcp", "toolkit", "unknown"]

ToolingExecutionLocation = Literal["local", "remote"]

ToolingSafetyClass = Literal["standard", "sensitive", "dangerous"]


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
    source_type: Literal["local", "mesh_peer"] = "local"
    execution_location: ToolingExecutionLocation = "local"
    safety_class: ToolingSafetyClass = "standard"
    required_permissions: list[str] = Field(default_factory=list)
    confirmation_required: bool = False
    rate_limit_hints: ToolingRateLimitHints | None = None
    provenance: ToolingToolProvenance


class ToolingGetToolsResponse(IOModel):
    """Response with available tools."""

    tools: list[ToolingToolInfo]
    count: int


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
    provider_peer_id: str | None = None
    provider_service_instance_id: str | None = None
    route_privacy_class: str | None = None
    token_ttl_seconds: int = 300


class ToolingSharingPolicy(IOModel):
    """Tooling sharing policy visible to admin clients."""

    default_share: bool = True
    default_approval_mode: ToolingApprovalMode = "ask_each_time"
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
    correlation_id: str | None = None


class ToolingSetSharingPolicyResponse(IOModel):
    """Policy update result."""

    ok: bool
    policy: ToolingSharingPolicy
    correlation_id: str | None = None


class ToolingExecuteToolRequest(IOModel):
    """Request to execute a tool."""

    tool_name: str
    arguments: dict[str, Any]
    mesh_selector: MeshAddressSelector | None = None
    resource_selector: ToolingResourceSelector | None = None
    confirmed: bool = False
    approval_token: str | None = None
    dry_run: bool = False
    correlation_id: str | None = None
    caller_peer_id: str | None = None
    caller_principal_id: str | None = None
    caller_device_id: str | None = None


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


class ToolingToolsInitializedEvent(IOModel):
    """Event emitted when tools are initialized."""

    total_tools: int
    mcp_tools_loaded: int


class ToolingToolsReloadedEvent(IOModel):
    """Event emitted when tools are reloaded."""

    total_tools: int
