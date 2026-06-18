"""Gateway contract models for service discovery and HTTP API.

This module defines the contracts for:
- Service announcements (services announcing their availability)
- Gateway methods (registry export, service listing)
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import Field

from app.shared.contracts.registry import IOModel

# =============================================================================
# Module Identifiers
# =============================================================================


class GatewayModule:
    """Module identifier for Gateway service."""

    NAME = "Gateway"


# =============================================================================
# Method Identifiers
# =============================================================================


class GatewayMethods:
    """Full method identifiers for Gateway service."""

    # Service discovery events
    SERVICE_ANNOUNCE = f"{GatewayModule.NAME}.ServiceAnnounce"
    SERVICE_DEPART = f"{GatewayModule.NAME}.ServiceDepart"
    SERVICE_HEARTBEAT = f"{GatewayModule.NAME}.ServiceHeartbeat"

    # Gateway queries
    GET_REGISTRY = f"{GatewayModule.NAME}.GetRegistry"
    GET_SERVICES = f"{GatewayModule.NAME}.GetServices"
    GET_SERVICE_HEALTH = f"{GatewayModule.NAME}.GetServiceHealth"
    GET_MESH_STATUS = f"{GatewayModule.NAME}.GetMeshStatus"
    GET_CAPABILITY_GRAPH = f"{GatewayModule.NAME}.GetCapabilityGraph"
    GET_CAPABILITY_CATALOG = f"{GatewayModule.NAME}.GetCapabilityCatalog"
    EXPLAIN_ROUTE = f"{GatewayModule.NAME}.ExplainRoute"


# =============================================================================
# Service Discovery Models
# =============================================================================


class MethodInfo(IOModel):
    """Information about a single service method."""

    name: str
    summary: str = ""
    bus_topic: str | None = None
    exposure: str = "internal"
    input_model: str | None = None
    output_model: str | None = None
    required_perms: list[str] = Field(default_factory=list)
    method_type: str = "use"
    # JSON Schema for input/output models (for OpenAPI generation)
    input_schema: dict[str, Any] | None = None
    output_schema: dict[str, Any] | None = None


class ServiceAnnouncement(IOModel):
    """Announcement of service availability.

    Services publish this when they start to announce their capabilities.
    The gateway aggregates these to know what services are available.
    """

    module: str
    version: str
    summary: str = ""
    capabilities: list[str] = Field(default_factory=list)
    methods: list[MethodInfo] = Field(default_factory=list)
    timestamp: str = Field(default_factory=lambda: datetime.utcnow().isoformat())
    # Unique instance ID (for multiple instances of same service)
    instance_id: str | None = None


class ServiceDeparture(IOModel):
    """Announcement of service shutdown.

    Services publish this when they stop gracefully.
    """

    module: str
    instance_id: str | None = None
    timestamp: str = Field(default_factory=lambda: datetime.utcnow().isoformat())
    reason: str = "shutdown"


class ServiceHeartbeat(IOModel):
    """Periodic heartbeat from a service.

    Used to detect crashed services that didn't send departure.
    """

    module: str
    instance_id: str | None = None
    timestamp: str = Field(default_factory=lambda: datetime.utcnow().isoformat())


# =============================================================================
# Gateway Query/Response Models
# =============================================================================


class ModuleRegistryInfo(IOModel):
    """Information about a registered module in the registry."""

    module: str
    version: str = ""
    summary: str = ""
    capabilities: list[str] = Field(default_factory=list)
    methods: list[MethodInfo] = Field(default_factory=list)


class GetRegistryResponse(IOModel):
    """Response containing the aggregated registry."""

    modules: list[ModuleRegistryInfo] = Field(default_factory=list)
    digest: str = ""
    service_count: int = 0
    method_count: int = 0


class ServiceInfo(IOModel):
    """Information about a running service."""

    module: str
    version: str
    summary: str = ""
    capabilities: list[str] = Field(default_factory=list)
    method_count: int = 0
    last_seen: str = ""
    status: str = "unknown"  # "healthy", "degraded", "unhealthy", "unknown"
    instance_id: str | None = None


class GetServicesResponse(IOModel):
    """Response containing list of known services."""

    services: list[ServiceInfo] = Field(default_factory=list)
    mode: str = "threads"  # "threads" or "processes"


class GetServiceHealthRequest(IOModel):
    """Request health check for a specific service."""

    module: str


class GetServiceHealthResponse(IOModel):
    """Response with service health status."""

    module: str
    status: str  # "healthy", "degraded", "unhealthy", "unknown"
    checks: dict[str, str] = Field(default_factory=dict)  # Component name -> status
    timestamp: str = ""
    error: str | None = None


class MeshLocalStatus(IOModel):
    """Local mesh identity and runtime status."""

    mesh_enabled: bool = False
    mesh_started: bool = False
    webrtc_started: bool = False
    peer_id: str | None = None
    node_name: str = ""
    peer_selection: str = ""
    version_policy: str = ""
    shared_modules: list[str] = Field(default_factory=list)
    routed_modules: list[str] = Field(default_factory=list)


class MeshPeerServiceDiagnostic(IOModel):
    """Diagnostic view of a service advertised by a mesh peer."""

    module: str
    version: str = ""
    capabilities: list[str] = Field(default_factory=list)
    method_names: list[str] = Field(default_factory=list)
    max_concurrent: int = 0
    active_calls: int = 0
    available_capacity: int | None = None
    digest: str = ""


class MeshPeerCompatibilityDiagnostic(IOModel):
    """Compatibility reports for a peer's manifest negotiation."""

    local_compatible: list[str] = Field(default_factory=list)
    local_incompatible: list[str] = Field(default_factory=list)
    local_unused: list[str] = Field(default_factory=list)
    remote_compatible: list[str] = Field(default_factory=list)
    remote_incompatible: list[str] = Field(default_factory=list)
    remote_unused: list[str] = Field(default_factory=list)


class MeshPeerDiagnostic(IOModel):
    """Runtime diagnostic view of one mesh peer."""

    peer_id: str
    node_name: str = ""
    status: str = "unknown"
    latency_ms: float | None = None
    last_ping_age_s: float | None = None
    last_manifest_age_s: float | None = None
    active_calls: int = 0
    services: list[MeshPeerServiceDiagnostic] = Field(default_factory=list)
    compatibility: MeshPeerCompatibilityDiagnostic = Field(
        default_factory=MeshPeerCompatibilityDiagnostic
    )


class MeshRouteProviderDiagnostic(IOModel):
    """Why one peer is or is not eligible to provide a module."""

    peer_id: str
    node_name: str = ""
    status: str = "unknown"
    version: str = ""
    latency_ms: float | None = None
    active_calls: int = 0
    max_concurrent: int = 0
    eligible: bool = False
    reason_code: str = ""
    reason: str = ""


class MeshRouteDiagnostic(IOModel):
    """Diagnostic view of routing for one service module."""

    module: str
    configured: bool = False
    share: bool = False
    prefer: str = ""
    fallback: str = ""
    min_version: str | None = None
    required_capabilities: list[str] = Field(default_factory=list)
    decision_target: str = "local"
    decision_peer_id: str | None = None
    decision_version: str = ""
    decision_latency_ms: float | None = None
    reason: str = ""
    providers: list[MeshRouteProviderDiagnostic] = Field(default_factory=list)


class MeshCompatibilityFailure(IOModel):
    """Flattened compatibility failure for operator scanning."""

    peer_id: str
    module: str
    direction: str
    reason: str = ""


class GetMeshStatusResponse(IOModel):
    """Read-only mesh status and route diagnostic dump."""

    local: MeshLocalStatus = Field(default_factory=MeshLocalStatus)
    peers: list[MeshPeerDiagnostic] = Field(default_factory=list)
    routes: list[MeshRouteDiagnostic] = Field(default_factory=list)
    compatibility_failures: list[MeshCompatibilityFailure] = Field(default_factory=list)
    secrets_redacted: bool = True


class CapabilityPolicyInfo(IOModel):
    """Policy metadata attached to a capability graph node.

    The graph is diagnostic and planning-oriented. Policy fields explain
    constraints without embedding credentials or executable policy state.
    """

    trust_tier: str = "unknown"
    safety_class: str = "standard"
    required_perms: list[str] = Field(default_factory=list)
    allowed_peers: list[str] | None = None
    explicit_selector_required: bool = False
    confirmation_required: bool = False
    consent_required: bool = False
    privacy_indicator_required: bool = False
    bandwidth_check_required: bool = False
    operation_class: str | None = None
    resource_scope: str | None = None
    rate_limit_key: str | None = None
    mesh_visible: bool = False
    local_only: bool = False


class CapabilityAddressInfo(IOModel):
    """Stable selector fields callers can use to address a capability."""

    peer_id: str
    module: str | None = None
    service_instance_id: str | None = None
    method: str | None = None
    tool_id: str | None = None
    resource_id: str | None = None
    namespace: str | None = None


class CapabilityProvenanceInfo(IOModel):
    """Where graph data came from and how fresh it is."""

    source: str = "unknown"
    peer_id: str | None = None
    manifest_timestamp: str | None = None
    registry_digest: str = ""


class CapabilityMethodInfo(IOModel):
    """A callable method exposed by a service instance."""

    method_id: str
    module: str
    name: str
    bus_topic: str | None = None
    exposure: str = "internal"
    method_type: str = "use"
    summary: str = ""
    input_model: str | None = None
    output_model: str | None = None
    input_schema: dict[str, Any] | None = None
    output_schema: dict[str, Any] | None = None
    policy: CapabilityPolicyInfo = Field(default_factory=CapabilityPolicyInfo)
    address: CapabilityAddressInfo
    provenance: CapabilityProvenanceInfo = Field(default_factory=CapabilityProvenanceInfo)


class CapabilityResourceInfo(IOModel):
    """Explicitly addressable resource placeholder for future graph producers."""

    resource_id: str
    resource_type: str
    owner_peer_id: str
    service_instance_id: str | None = None
    namespace: str | None = None
    display_name: str = ""
    capabilities: list[str] = Field(default_factory=list)
    policy: CapabilityPolicyInfo = Field(default_factory=CapabilityPolicyInfo)
    address: CapabilityAddressInfo
    provenance: CapabilityProvenanceInfo = Field(default_factory=CapabilityProvenanceInfo)


class CapabilityServiceInfo(IOModel):
    """A service instance provided by the local node or a remote peer."""

    service_instance_id: str
    peer_id: str
    provider_kind: str = "remote"
    module: str
    version: str = ""
    summary: str = ""
    capabilities: list[str] = Field(default_factory=list)
    method_count: int = 0
    methods: list[CapabilityMethodInfo] = Field(default_factory=list)
    max_concurrent: int = 0
    active_calls: int = 0
    available_capacity: int | None = None
    latency_ms: float | None = None
    digest: str = ""
    share: bool = False
    routable: bool = False
    route_blockers: list[str] = Field(default_factory=list)
    policy: CapabilityPolicyInfo = Field(default_factory=CapabilityPolicyInfo)
    address: CapabilityAddressInfo
    provenance: CapabilityProvenanceInfo = Field(default_factory=CapabilityProvenanceInfo)


class CapabilityPeerInfo(IOModel):
    """Peer node in the capability graph."""

    peer_id: str
    node_name: str = ""
    provider_kind: str = "remote"
    status: str = "unknown"
    latency_ms: float | None = None
    service_instance_ids: list[str] = Field(default_factory=list)
    policy: CapabilityPolicyInfo = Field(default_factory=CapabilityPolicyInfo)
    provenance: CapabilityProvenanceInfo = Field(default_factory=CapabilityProvenanceInfo)


class CapabilityGraph(IOModel):
    """Read-only graph of mesh peers and addressable capabilities."""

    local_peer_id: str | None = None
    local_node_name: str = ""
    generated_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat())
    peers: list[CapabilityPeerInfo] = Field(default_factory=list)
    services: list[CapabilityServiceInfo] = Field(default_factory=list)
    resources: list[CapabilityResourceInfo] = Field(default_factory=list)
    provider_index: dict[str, list[str]] = Field(default_factory=dict)
    candidate_provider_index: dict[str, list[str]] = Field(default_factory=dict)
    selector_kinds: list[str] = Field(
        default_factory=lambda: [
            "peer_id",
            "service_instance_id",
            "module",
            "method",
            "tool_id",
            "resource_id",
            "namespace",
        ]
    )
    secrets_redacted: bool = True


class CapabilityFreshnessInfo(IOModel):
    """Source and staleness metadata for catalog entries."""

    source: str = "unknown"
    manifest_time: str | None = None
    last_probe_age_s: float | None = None
    ttl_s: float | None = None
    stale: bool = False
    registry_digest: str = ""


class CapabilityPolicyDecisionInfo(IOModel):
    """Policy facts needed by SDK/UI bindability decisions."""

    required_permissions: list[str] = Field(default_factory=list)
    trust_tier: str = "unknown"
    safety_class: str = "standard"
    explicit_selector_required: bool = False
    consent_required: bool = False
    privacy_indicator_required: bool = False
    bandwidth_check_required: bool = False
    approval_required: bool = False
    selector_required: bool = False
    mesh_visible: bool = False
    local_only: bool = False
    allowed_peers: list[str] | None = None
    operation_class: str | None = None
    resource_scope: str | None = None
    denial_reasons: list[str] = Field(default_factory=list)


class CapabilityProviderInfo(IOModel):
    """One local or remote provider for a capability module."""

    provider_id: str
    peer_id: str
    provider_kind: str = "remote"
    node_name: str = ""
    status: str = "unknown"
    service_instance_id: str
    module: str
    version: str = ""
    latency_ms: float | None = None
    max_concurrent: int = 0
    active_calls: int = 0
    available_capacity: int | None = None
    eligible: bool = False
    reason_code: str = ""
    reason: str = ""
    policy: CapabilityPolicyDecisionInfo = Field(default_factory=CapabilityPolicyDecisionInfo)
    freshness: CapabilityFreshnessInfo = Field(default_factory=CapabilityFreshnessInfo)


class CapabilityActionInfo(IOModel):
    """Executable or explainable capability action for SDK/UI consumers."""

    action_id: str
    module: str
    method: str
    topic: str | None = None
    tool_id: str | None = None
    resource_id: str | None = None
    provider_id: str
    peer_id: str
    provider_kind: str = "remote"
    service_instance_id: str
    # Runtime value is app.shared.contracts.models.mesh.MeshAddressSelector.
    selector: Any
    bindability: str = "unavailable"
    sdk_operation_kind: str = "bus_method"
    route_hints: list[str] = Field(default_factory=list)
    route_blockers: list[str] = Field(default_factory=list)
    summary: str = ""
    input_schema: dict[str, Any] | None = None
    output_schema: dict[str, Any] | None = None
    policy: CapabilityPolicyDecisionInfo = Field(default_factory=CapabilityPolicyDecisionInfo)
    freshness: CapabilityFreshnessInfo = Field(default_factory=CapabilityFreshnessInfo)


class CapabilityCatalogResourceInfo(IOModel):
    """Addressable resource advertised through the capability catalog."""

    resource_id: str
    resource_type: str
    owner_peer_id: str
    service_instance_id: str | None = None
    namespace: str | None = None
    display_name: str = ""
    capabilities: list[str] = Field(default_factory=list)
    # Runtime value is app.shared.contracts.models.mesh.MeshAddressSelector.
    selector: Any
    policy: CapabilityPolicyDecisionInfo = Field(default_factory=CapabilityPolicyDecisionInfo)
    freshness: CapabilityFreshnessInfo = Field(default_factory=CapabilityFreshnessInfo)


class CapabilityCatalogRequest(IOModel):
    """Request a canonical executable capability catalog."""

    modules: list[str] | None = None
    include_unavailable: bool = True
    include_internal: bool = False
    include_schemas: bool = True


class CapabilityCatalogResponse(IOModel):
    """Canonical SDK/UI capability catalog."""

    generated_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat())
    local_peer_id: str | None = None
    local_node_name: str = ""
    providers: list[CapabilityProviderInfo] = Field(default_factory=list)
    actions: list[CapabilityActionInfo] = Field(default_factory=list)
    resources: list[CapabilityCatalogResourceInfo] = Field(default_factory=list)
    provider_index: dict[str, list[str]] = Field(default_factory=dict)
    action_index: dict[str, list[str]] = Field(default_factory=dict)
    secrets_redacted: bool = True


class RouteBlockerInfo(IOModel):
    """Route blocker or selector validation problem."""

    code: str
    message: str
    severity: str = "error"
    provider_id: str | None = None
    peer_id: str | None = None
    security_privacy: bool = False


class RouteCandidateDecision(IOModel):
    """Eligibility and selection decision for one route candidate."""

    provider_id: str
    peer_id: str
    provider_kind: str = "remote"
    service_instance_id: str
    module: str
    version: str = ""
    included: bool = False
    selected: bool = False
    reason_code: str = ""
    reason: str = ""
    latency_ms: float | None = None
    active_calls: int = 0
    max_concurrent: int = 0
    available_capacity: int | None = None
    blockers: list[RouteBlockerInfo] = Field(default_factory=list)


class RouteExplainRequest(IOModel):
    """Explain how Gateway would route a topic/module selector."""

    topic: str | None = None
    module: str | None = None
    method: str | None = None
    # Runtime value is app.shared.contracts.models.mesh.MeshAddressSelector.
    selector: Any | None = None
    include_candidates: bool = True


class RouteExplainResponse(IOModel):
    """Route selection explanation for SDK route sheets."""

    topic: str
    module: str
    selected_target: str = "local"
    selected_peer_id: str | None = None
    selected_service_instance_id: str | None = None
    selected_provider_id: str | None = None
    selector_valid: bool = True
    selector_validation_code: str = ""
    selector_validation_message: str = ""
    fallback_behavior: str = ""
    candidates: list[RouteCandidateDecision] = Field(default_factory=list)
    blockers: list[RouteBlockerInfo] = Field(default_factory=list)
    security_privacy_blockers: list[RouteBlockerInfo] = Field(default_factory=list)
    secrets_redacted: bool = True


class ServiceCountInfo(IOModel):
    """Service count information."""

    total: int = 0
    healthy: int = 0


class HealthCheckResponse(IOModel):
    """Response from gateway health check."""

    status: str  # "healthy" or "degraded"
    timestamp: str
    gateway: str = "up"
    services: ServiceCountInfo = Field(default_factory=ServiceCountInfo)
    routes: int = 0


class ServiceRoutes(IOModel):
    """Routes for a single service."""

    service: str
    routes: list[str] = Field(default_factory=list)


class GetRoutesResponse(IOModel):
    """Response containing route information."""

    total_routes: int = 0
    services: list[ServiceRoutes] = Field(default_factory=list)


class ServiceDetailsResponse(IOModel):
    """Detailed information about a specific service."""

    module: str
    version: str = ""
    summary: str = ""
    capabilities: list[str] = Field(default_factory=list)
    methods: list[MethodInfo] = Field(default_factory=list)
    timestamp: str = ""
