"""Gateway contract models for service discovery and HTTP API.

This module defines the contracts for:
- Service announcements (services announcing their availability)
- Gateway methods (registry export, service listing)
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import ConfigDict, Field, field_validator, model_validator

from app.shared.contracts.mesh_compatibility import (
    MeshCompatibilityReasonCode,
    MeshRoutingReasonCode,
    MeshServiceCompatibilityStatus,
)
from app.shared.contracts.models.aurora import (
    AuroraEventCategory,
    AuroraEventStreamEvent,
    AuroraMethods,
)
from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.models.orchestrator import (
    OrchestratorInferChatChunk,
    OrchestratorInferChatRequest,
    OrchestratorInferChatResponse,
)
from app.shared.contracts.models.speech import (
    MAX_JS_SAFE_INTEGER,
    LogicalVoiceId,
    SpeechLanguageRequirement,
    SpeechMethodConstraints,
)
from app.shared.contracts.models.tooling import (
    ToolingGetExportCatalogRequest,
    ToolingGetExportCatalogResponse,
)
from app.shared.contracts.registry import CallableFeatureContract, IOModel

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
    GET_DEPLOYMENT_TOPOLOGY = f"{GatewayModule.NAME}.GetDeploymentTopology"
    GET_MESH_STATUS = f"{GatewayModule.NAME}.GetMeshStatus"
    GET_MESH_INVITE_CONFIG = f"{GatewayModule.NAME}.GetMeshInviteConfig"
    GET_CAPABILITY_GRAPH = f"{GatewayModule.NAME}.GetCapabilityGraph"
    GET_CAPABILITY_CATALOG = f"{GatewayModule.NAME}.GetCapabilityCatalog"
    EXPLAIN_ROUTE = f"{GatewayModule.NAME}.ExplainRoute"
    GET_WEBRTC_DIAGNOSTICS = f"{GatewayModule.NAME}.GetWebRTCDiagnostics"
    EVENT_STREAM = AuroraMethods.EVENT_STREAM
    LIST_EVENTS = f"{GatewayModule.NAME}.ListEvents"
    GET_SUPPORT_BUNDLE = f"{GatewayModule.NAME}.GetSupportBundle"
    ADMIN_ACTION_DRAFT = f"{GatewayModule.NAME}.AdminActionDraft"
    ADMIN_ACTION_CONFIRM = f"{GatewayModule.NAME}.AdminActionConfirm"
    MESH_INFER_CHAT = f"{GatewayModule.NAME}.MeshInferChat"
    STREAM_MESH_INFER_CHAT = f"{GatewayModule.NAME}.StreamMeshInferChat"
    CANCEL_MESH_INFER_CHAT_STREAM = f"{GatewayModule.NAME}.CancelMeshInferChatStream"
    MESH_INFER_CHAT_CHUNK = f"{GatewayModule.NAME}.MeshInferChatChunk"
    FETCH_TOOLING_EXPORT_CATALOG_PAGE = f"{GatewayModule.NAME}.FetchToolingExportCatalogPage"


# =============================================================================
# Service Discovery Models
# =============================================================================


class GatewayFetchToolingExportCatalogPageRequest(IOModel):
    """Trusted local proxy request; provider address never enters Tooling DTOs."""

    provider_peer_id: str = Field(min_length=1, max_length=160)
    request: ToolingGetExportCatalogRequest


class GatewayFetchToolingExportCatalogPageResponse(IOModel):
    """Typed proxy result retaining bounded transport failure semantics."""

    ok: bool = True
    reason_code: str | None = Field(default=None, max_length=128)
    page: ToolingGetExportCatalogResponse | None = None
    granted_permissions: list[str] = Field(default_factory=list, max_length=1024)


class MethodInfo(IOModel):
    """Information about a single service method."""

    name: str
    summary: str = ""
    bus_topic: str | None = None
    exposure: str = "internal"
    input_model: str | None = None
    output_model: str | None = None
    required_perms: list[str] = Field(default_factory=list)
    callable_feature_ids: list[str] = Field(default_factory=list)
    callable_features: list[CallableFeatureContract] = Field(default_factory=list)
    public_infrastructure: bool = False
    method_type: str = "use"
    speech_constraints: SpeechMethodConstraints | None = None
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
    callable_features: list[CallableFeatureContract] = Field(default_factory=list)
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
    callable_features: list[CallableFeatureContract] = Field(default_factory=list)
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
    callable_features: list[CallableFeatureContract] = Field(default_factory=list)
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


class BusHealth(IOModel):
    """Read-only message bus health and dependency state."""

    backend: str = "unknown"
    redis_url_redacted: str | None = None
    redis_reachable: bool | None = None
    bullmq_available: bool | None = None
    queue_lag_known: bool = False
    queue_depth: int | None = None
    published: int | None = None
    delivered: int | None = None
    retries: int | None = None
    dead_letters: int | None = None
    status: str = "unknown"
    degraded_reasons: list[str] = Field(default_factory=list)
    error: str | None = None


class ServiceProcessTopology(IOModel):
    """Sanitized process/thread/container topology for one service."""

    module: str
    status: str = "unknown"
    topology: str = "unknown"
    instance_id: str | None = None
    container_hint: str | None = None
    process_hint: str | None = None
    last_seen: str | None = None
    stale: bool = False


class ContainerTopologyHints(IOModel):
    """Sanitized container/process-mode topology hints."""

    orchestrator: str = "unknown"
    compose_file: str | None = None
    redis_service: str | None = None
    gateway_service: str | None = None
    config_service: str | None = None
    notes: list[str] = Field(default_factory=list)


class DeploymentTopologyResponse(IOModel):
    """Read-only deployment topology and bus health for UI/SDK consumers."""

    architecture_mode: str = "threads"
    runtime_mode: str = "local"
    bus_backend: str = "LocalBus"
    redis_url_redacted: str | None = None
    redis_reachable: bool | None = None
    bullmq_queue_health: BusHealth = Field(default_factory=BusHealth)
    service_process_topology: list[ServiceProcessTopology] = Field(default_factory=list)
    container_topology_hints: ContainerTopologyHints = Field(default_factory=ContainerTopologyHints)
    mode_capability_degradations: list[str] = Field(default_factory=list)
    mesh_peer_topology_trusted: bool | None = None
    generated_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat())
    secrets_redacted: bool = True


class GatewayMeshInferChatRequest(IOModel):
    """Proxy a fixed Orchestrator.InferChat call through Gateway-owned mesh.

    The topic is intentionally not caller-controlled: Gateway forwards only to
    Orchestrator.InferChat using its MeshBus/PeerBridge so process-mode
    Orchestrator containers do not need direct WebRTC access.
    """

    request: OrchestratorInferChatRequest
    mesh_selector: MeshAddressSelector | None = None
    principal_id: str | None = None
    effective_perms: list[str] | None = None
    identity_source: str | None = None
    method_type: str | None = None
    caller_peer_id: str | None = None
    origin: str | None = None


class GatewayMeshInferChatResponse(IOModel):
    """Complete response from a Gateway-owned remote mesh inference call."""

    response: OrchestratorInferChatResponse


class GatewayStreamMeshInferChatStartRequest(IOModel):
    """Start a Gateway-owned remote mesh inference stream.

    Chunks are published as Gateway.MeshInferChatChunk events keyed by
    stream_id/correlation_id instead of returning an async generator through a
    process bus transport.
    """

    stream_id: str
    request: OrchestratorInferChatRequest
    mesh_selector: MeshAddressSelector | None = None
    principal_id: str | None = None
    effective_perms: list[str] | None = None
    identity_source: str | None = None
    method_type: str | None = None
    caller_peer_id: str | None = None
    origin: str | None = None


class GatewayStreamMeshInferChatStartResponse(IOModel):
    """Acknowledgement that Gateway accepted stream proxy ownership."""

    stream_id: str
    accepted: bool = True
    correlation_id: str | None = None


class GatewayCancelMeshInferChatStreamRequest(IOModel):
    """Cancel a Gateway-owned remote mesh inference stream."""

    stream_id: str
    principal_id: str | None = None
    identity_source: str | None = None
    caller_peer_id: str | None = None
    origin: str | None = None


class GatewayCancelMeshInferChatStreamResponse(IOModel):
    """Result of cancelling a Gateway-owned stream proxy."""

    stream_id: str
    cancelled: bool = False


class GatewayMeshInferChatChunkEvent(IOModel):
    """One Gateway proxy stream event for remote mesh inference."""

    stream_id: str
    chunk: OrchestratorInferChatChunk | None = None
    is_final: bool = False
    error: str | None = None
    correlation_id: str | None = None
    sequence: int = 0


class AdminActionHeaderNames(IOModel):
    """HTTP headers used to submit a confirmed AdminAction."""

    action_id: str = "X-Aurora-AdminAction-Id"
    confirmation_token: str = "X-Aurora-AdminAction-Token"
    digest: str = "X-Aurora-AdminAction-Digest"


class AdminActionDraftRequest(IOModel):
    """Request a short-lived draft for a high-risk admin action."""

    method_id: str
    payload: dict[str, Any] = Field(default_factory=dict)
    affected_resources: list[str] = Field(default_factory=list)


class AdminActionDraftResponse(IOModel):
    """Draft details that a client must display before confirmation."""

    action_id: str
    nonce: str
    digest: str
    method_id: str
    affected_resources: list[str] = Field(default_factory=list)
    required_phrase: str = "CONFIRM"
    required_reason: bool = True
    required_reauth: bool = True
    expires_at: str
    expires_in_seconds: int
    confirmation_headers: AdminActionHeaderNames = Field(default_factory=AdminActionHeaderNames)


class AdminActionConfirmRequest(IOModel):
    """Confirm a drafted AdminAction after reauth/reason collection."""

    action_id: str
    nonce: str
    digest: str
    reason: str
    reauth_confirmed: bool
    phrase: str = "CONFIRM"


class AdminActionConfirmResponse(IOModel):
    """Single-use confirmation token for submitting the matching action."""

    action_id: str
    confirmation_token: str
    digest: str
    confirmed: bool = True
    expires_at: str
    audit_receipt: str
    confirmation_headers: AdminActionHeaderNames = Field(default_factory=AdminActionHeaderNames)


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


class MeshRevisionDiagnostic(IOModel):
    """Safe protocol and authority revisions for an assessed manifest."""

    active_protocol: str = ""
    active_version: str = ""
    active_tier: str = ""
    protocol_revision: str | None = None
    registry_revision: str = ""
    export_policy_revision: str = ""
    auth_grant_revision: int | None = None
    projection_digest: str = ""


class MeshServiceCompatibilityDiagnostic(IOModel):
    """Structured compatibility result keyed by a stable service identifier."""

    service_id: str
    service_label: str = ""
    status: MeshServiceCompatibilityStatus = "unused"
    reason_codes: list[MeshCompatibilityReasonCode] = Field(default_factory=list)
    reason: str = ""


class MeshPeerCompatibilityDiagnostic(IOModel):
    """Compatibility reports for a peer's manifest negotiation."""

    local_compatible: list[str] = Field(default_factory=list)
    local_incompatible: list[str] = Field(default_factory=list)
    local_unused: list[str] = Field(default_factory=list)
    remote_compatible: list[str] = Field(default_factory=list)
    remote_incompatible: list[str] = Field(default_factory=list)
    remote_unused: list[str] = Field(default_factory=list)
    local_revision: MeshRevisionDiagnostic = Field(default_factory=MeshRevisionDiagnostic)
    remote_revision: MeshRevisionDiagnostic = Field(default_factory=MeshRevisionDiagnostic)
    local_services: list[MeshServiceCompatibilityDiagnostic] = Field(default_factory=list)
    remote_services: list[MeshServiceCompatibilityDiagnostic] = Field(default_factory=list)


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
    reason_code: MeshCompatibilityReasonCode | Literal[""] = ""
    reason: str = ""


class MeshServiceExportSummary(IOModel):
    """Local provider-export state for one stable service identifier."""

    service_id: str
    service_label: str = ""
    shared: bool = False
    policy_revision: int = 0
    reason_codes: list[MeshCompatibilityReasonCode] = Field(default_factory=list)
    excluded_method_count: int = 0
    excluded_feature_count: int = 0


class MeshServiceRoutingSummary(IOModel):
    """Outbound routing state for one stable service identifier."""

    service_id: str
    service_label: str = ""
    configured: bool = False
    prefer: str = ""
    fallback: str = ""
    policy_revision: int = 0
    eligible_provider_ids: list[str] = Field(default_factory=list)
    ineligible_provider_ids: list[str] = Field(default_factory=list)
    reason_codes: list[MeshRoutingReasonCode] = Field(default_factory=list)


class GetMeshStatusResponse(IOModel):
    """Read-only mesh status and route diagnostic dump."""

    local: MeshLocalStatus = Field(default_factory=MeshLocalStatus)
    peers: list[MeshPeerDiagnostic] = Field(default_factory=list)
    routes: list[MeshRouteDiagnostic] = Field(default_factory=list)
    export_summaries: list[MeshServiceExportSummary] = Field(default_factory=list)
    routing_summaries: list[MeshServiceRoutingSummary] = Field(default_factory=list)
    compatibility_failures: list[MeshCompatibilityFailure] = Field(default_factory=list)
    secrets_redacted: bool = True


class GetMeshInviteConfigResponse(IOModel):
    """Admin-only signaling material required to create a mesh invite."""

    app_id: str = ""
    room: str = ""
    room_password: str = Field(default="", repr=False)


class WebRTCSignalingDiagnostic(IOModel):
    """Safe signaling-plane status for WebRTC diagnostics."""

    strategy: str = ""
    connected: bool = False
    encrypted_presence: bool = False
    app_id_configured: bool = False
    room_configured: bool = False
    broker_count: int = 0
    public_broker_warning: bool = False


class WebRTCPeerDiagnostic(IOModel):
    """Safe per-peer WebRTC, ICE, data-channel, and auth diagnostic state."""

    signaling_peer_id: str
    stable_peer_id: str
    node_name: str = ""
    connection_state: str = "unknown"
    ice_connection_state: str = "unknown"
    ice_gathering_state: str = "unknown"
    signaling_state: str = "unknown"
    data_channel_state: str = "unknown"
    data_channel_label: str = ""
    has_send_channel: bool = False
    rtt_ms: float | None = None
    auth_state: str = "unknown"
    identity_source: str = ""
    is_admin: bool = False
    effective_permission_count: int = 0
    pairing_active: bool = False
    auth_timeout_pending: bool = False
    pending_pairing_task: bool = False
    pairing_session_id: str = ""
    verification_code: str = ""


class WebRTCDiagnosticError(IOModel):
    """Redacted recent WebRTC diagnostic error or lifecycle warning."""

    timestamp: str
    code: str
    message: str
    peer_id: str | None = None


class WebRTCDiagnosticsResponse(IOModel):
    """Read-only WebRTC, ICE, signaling, and DataChannel diagnostics.

    Peer counts include only sessions whose peer connection and canonical RPC
    DataChannel are both operational. The full ``peers`` collection can also
    contain transitional or terminal sessions awaiting asynchronous cleanup.
    """

    enabled: bool = False
    started: bool = False
    mesh_enabled: bool = False
    local_signaling_peer_id: str | None = None
    local_mesh_peer_id: str | None = None
    local_node_name: str = ""
    require_auth: bool = False
    auth_timeout_seconds: float = 0.0
    pairing_timeout_seconds: float = 0.0
    app_layer_e2ee_enabled: bool = False
    signaling: WebRTCSignalingDiagnostic = Field(default_factory=WebRTCSignalingDiagnostic)
    peers: list[WebRTCPeerDiagnostic] = Field(default_factory=list)
    connected_peer_count: int = 0
    authenticated_peer_count: int = 0
    pairing_peer_count: int = 0
    pending_rpc_count: int = 0
    recent_errors: list[WebRTCDiagnosticError] = Field(default_factory=list)
    secrets_redacted: bool = True


GatewayEventStreamEvent = AuroraEventStreamEvent


class GatewayListEventsRequest(IOModel):
    """Query the bounded Gateway event buffer."""

    topics: list[str] | None = None
    categories: list[AuroraEventCategory] | None = None
    kinds: list[str] | None = None
    action: str | None = None
    status: str | None = None
    correlation_id: str | None = None
    last_event_id: str | None = None
    replay_from: str | None = None
    peer_id: str | None = None
    provider_id: str | None = None
    tool_id: str | None = None
    route: str | None = None
    policy_decision_id: str | None = None
    limit: int = Field(default=100, ge=1, le=500)


class GatewayListEventsResponse(IOModel):
    """Response containing recent normalized Gateway events."""

    events: list[GatewayEventStreamEvent] = Field(default_factory=list)
    total: int = 0
    subscription_topic: str = GatewayMethods.EVENT_STREAM
    secrets_redacted: bool = True


class SupportBundleRedactionInfo(IOModel):
    """Redaction assertions for a support bundle."""

    secrets_redacted: bool = True
    redacted_fields: list[str] = Field(default_factory=list)
    omitted_payloads: list[str] = Field(default_factory=list)


class SupportBundleDiagnosticItem(IOModel):
    """One redacted support-bundle diagnostic source."""

    name: str
    status: str = "unavailable"
    source: str = ""
    details: dict[str, Any] = Field(default_factory=dict)
    redacted: bool = True


class MeshRolloutPeerMetrics(IOModel):
    """Payload-free rollout state for one stable authenticated peer."""

    peer_id: str
    manifest_revision: int = 0
    catalog_revision: int = 0
    export_policy_revision: int = 0
    auth_grant_revision: int = 0
    switch_revision: int = 0
    projection_size: int = 0
    last_sync_duration_ms: float | None = None
    protocol_status: str = "unknown"
    last_reason_code: str | None = None
    counters: dict[str, int] = Field(default_factory=dict)


class MeshRolloutMetricsSnapshot(IOModel):
    """Bounded support-bundle metrics with no payload or schema content."""

    counters: dict[str, int] = Field(default_factory=dict)
    denied_by_reason: dict[str, int] = Field(default_factory=dict)
    peers: list[MeshRolloutPeerMetrics] = Field(default_factory=list)
    provider_mesh_tooling_enabled: bool | None = None
    consumer_mesh_tooling_enabled: bool | None = None
    rbac_preflight_release_blocking: bool | None = None
    downgrade_status: str = "not_applicable"
    secrets_redacted: bool = True


class GatewaySupportBundleRequest(IOModel):
    """Request a redacted support bundle for diagnostics."""

    correlation_id: str | None = None
    event_limit: int = Field(default=100, ge=0, le=500)
    audit_limit: int = Field(default=50, ge=0, le=500)
    include_capability_catalog: bool = True


class CapabilityCatalogSummary(IOModel):
    """Compact support-bundle summary of the capability catalog."""

    providers: int = 0
    actions: int = 0
    resources: int = 0
    modules: list[str] = Field(default_factory=list)
    blocked_actions: int = 0


class GatewaySupportBundleResponse(IOModel):
    """Redacted operator support bundle."""

    generated_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat())
    correlation_id: str | None = None
    registry: GetRegistryResponse = Field(default_factory=GetRegistryResponse)
    services: list[ServiceInfo] = Field(default_factory=list)
    service_health: list[GetServiceHealthResponse] = Field(default_factory=list)
    mesh_status: GetMeshStatusResponse = Field(default_factory=GetMeshStatusResponse)
    webrtc_diagnostics: WebRTCDiagnosticsResponse = Field(default_factory=WebRTCDiagnosticsResponse)
    route_diagnostics: list[MeshRouteDiagnostic] = Field(default_factory=list)
    capability_catalog_summary: CapabilityCatalogSummary = Field(
        default_factory=CapabilityCatalogSummary
    )
    recent_events: list[GatewayEventStreamEvent] = Field(default_factory=list)
    recent_audit_events: list[dict[str, Any]] = Field(default_factory=list)
    native_capabilities: list[SupportBundleDiagnosticItem] = Field(default_factory=list)
    sidecar_logs: list[SupportBundleDiagnosticItem] = Field(default_factory=list)
    mesh_rollout: MeshRolloutMetricsSnapshot = Field(default_factory=MeshRolloutMetricsSnapshot)
    config_shape: dict[str, Any] = Field(default_factory=dict)
    correlation_ids: list[str] = Field(default_factory=list)
    audit_receipt: str | None = None
    audit_error: str | None = None
    redaction: SupportBundleRedactionInfo = Field(default_factory=SupportBundleRedactionInfo)
    secrets_redacted: bool = True


class CapabilityPolicyInfo(IOModel):
    """Policy metadata attached to a capability graph node.

    The graph is diagnostic and planning-oriented. Policy fields explain
    constraints without embedding credentials or executable policy state.
    """

    trust_tier: str = "unknown"
    safety_class: str = "standard"
    required_perms: list[str] = Field(default_factory=list)
    required_callable_feature_ids: list[str] = Field(default_factory=list)
    allowed_provider_peer_ids: list[str] | None = None
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
    callable_feature_ids: list[str] = Field(default_factory=list)
    callable_features: list[CallableFeatureContract] = Field(default_factory=list)
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
    callable_features: list[CallableFeatureContract] = Field(default_factory=list)
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
    required_callable_feature_ids: list[str] = Field(default_factory=list)
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
    allowed_provider_peer_ids: list[str] | None = None
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
    callable_feature_ids: list[str] = Field(default_factory=list)
    callable_features: list[CallableFeatureContract] = Field(default_factory=list)
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
    # Unified monorepo version reported by this server (same value the mesh
    # manifest advertises as aurora_version); empty when unknown.
    aurora_version: str = ""
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
    projection_revision: str = ""
    projection_digest: str = ""
    latency_ms: float | None = None
    active_calls: int = Field(default=0, ge=0, le=MAX_JS_SAFE_INTEGER)
    max_concurrent: int = Field(default=0, ge=0, le=MAX_JS_SAFE_INTEGER)
    available_capacity: int | None = Field(default=None, ge=0, le=MAX_JS_SAFE_INTEGER)
    policy: CapabilityPolicyDecisionInfo = Field(default_factory=CapabilityPolicyDecisionInfo)
    freshness: CapabilityFreshnessInfo = Field(default_factory=CapabilityFreshnessInfo)
    auth_rbac_state: str = "unknown"
    transport: str = "unknown"
    privacy_class: str = "public"
    blockers: list[RouteBlockerInfo] = Field(default_factory=list)


_RAW_SPEECH_HINT_FIELDS = frozenset(
    {"text", "audio", "audio_data", "payload", "message", "messages", "input", "params"}
)
_MESH_SELECTOR_FIELDS = frozenset(MeshAddressSelector.model_fields)


def _contains_raw_payload_key(value: Any) -> bool:
    if isinstance(value, dict):
        if _RAW_SPEECH_HINT_FIELDS.intersection(value):
            return True
        return any(_contains_raw_payload_key(item) for item in value.values())
    if isinstance(value, list | tuple):
        return any(_contains_raw_payload_key(item) for item in value)
    return False


class RouteExplainSpeechConstraints(IOModel):
    """Typed speech routing hints for ExplainRoute without request payload data."""

    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    language_requirement: SpeechLanguageRequirement | None = None
    voice_id: LogicalVoiceId | None = None


class RouteExplainRequest(IOModel):
    """Explain how Gateway would route a topic/module selector."""

    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    topic: str | None = None
    module: str | None = None
    method: str | None = None
    selector: MeshAddressSelector | None = None
    speech: RouteExplainSpeechConstraints | None = None
    include_candidates: bool = True

    @model_validator(mode="before")
    @classmethod
    def _reject_raw_payload_fields(cls, value: Any) -> Any:
        if isinstance(value, dict):
            if _RAW_SPEECH_HINT_FIELDS.intersection(value):
                raise ValueError("route explanations must not include request payload fields")
            for key, item in value.items():
                if key != "speech" and _contains_raw_payload_key(item):
                    raise ValueError("route explanations must not include request payload fields")
        return value

    @field_validator("selector", mode="before")
    @classmethod
    def _reject_unknown_selector_fields(cls, value: Any) -> Any:
        if isinstance(value, dict) and set(value) - _MESH_SELECTOR_FIELDS:
            raise ValueError("route explanation selectors must use typed selector fields")
        return value

    @field_validator("speech", mode="before")
    @classmethod
    def _reject_raw_speech_payload_fields(cls, value: Any) -> Any:
        if isinstance(value, dict) and _RAW_SPEECH_HINT_FIELDS.intersection(value):
            raise ValueError("speech route hints must not include request payload fields")
        return value


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
