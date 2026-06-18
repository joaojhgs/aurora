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
    GET_TOOL_CATALOG = f"{ToolingModule.NAME}.GetToolCatalog"
    GET_TOOL_BY_NAME = f"{ToolingModule.NAME}.GetToolByName"
    GET_STATS = f"{ToolingModule.NAME}.GetStats"
    GET_MCP_STATUS = f"{ToolingModule.NAME}.GetMCPStatus"
    EXECUTE_TOOL = f"{ToolingModule.NAME}.ExecuteTool"
    RELOAD_MCP_TOOLS = f"{ToolingModule.NAME}.ReloadMCPTools"
    HEALTH_CHECK = f"{ToolingModule.NAME}.HealthCheck"
    TOOLS_INITIALIZED = f"{ToolingModule.NAME}.ToolsInitialized"
    TOOLS_RELOADED = f"{ToolingModule.NAME}.ToolsReloaded"


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
    execution_location: Literal["local", "remote"] = "local"
    safety_class: Literal["standard", "sensitive", "dangerous"] = "standard"
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


class ToolingExecuteToolRequest(IOModel):
    """Request to execute a tool."""

    tool_name: str
    arguments: dict[str, Any]
    mesh_selector: MeshAddressSelector | None = None
    resource_selector: ToolingResourceSelector | None = None
    confirmed: bool = False
    dry_run: bool = False
    correlation_id: str | None = None
    caller_peer_id: str | None = None
    caller_principal_id: str | None = None


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


class ToolingToolsInitializedEvent(IOModel):
    """Event emitted when tools are initialized."""

    total_tools: int
    mcp_tools_loaded: int


class ToolingToolsReloadedEvent(IOModel):
    """Event emitted when tools are reloaded."""

    total_tools: int
