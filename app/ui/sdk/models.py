"""Stable view models for future Aurora UI surfaces."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from app.shared.contracts.models.mesh import MeshAddressSelector

EvidenceState = Literal[
    "backend-proven",
    "pending",
    "denied",
    "degraded",
    "stale",
    "privacy-blocked",
    "deferred",
    "no-route",
    "hard-failure",
]

AvailabilityState = Literal[
    "available-local",
    "available-remote",
    "pending",
    "denied",
    "degraded",
    "stale",
    "privacy-blocked",
    "unsupported",
    "no-route",
    "hard-failure",
]


class AuditReference(BaseModel):
    """Copyable audit/tracing reference with redacted details only."""

    correlation_id: str | None = None
    event_kind: str = ""
    peer_id: str | None = None
    method: str | None = None
    tool_id: str | None = None
    resource_id: str | None = None
    status: str | None = None
    details_redacted: dict[str, Any] = Field(default_factory=dict)


class PeerSummary(BaseModel):
    """UI-safe mesh peer status from Gateway diagnostics and/or Auth peer state."""

    peer_id: str
    node_name: str = ""
    lifecycle_state: EvidenceState = "backend-proven"
    trust_state: EvidenceState = "pending"
    connection_status: str = "unknown"
    outbound_status: str | None = None
    inbound_status: str | None = None
    latency_ms: float | None = None
    stale_age_s: float | None = None
    service_count: int = 0
    last_evidence_source: str = "unknown"
    reason_codes: list[str] = Field(default_factory=list)


class RouteSummary(BaseModel):
    """Normalized route decision and provider eligibility diagnostics."""

    module: str
    availability: AvailabilityState
    decision_target: str = "none"
    provider_peer_id: str | None = None
    reason: str = ""
    fallback: str = ""
    fallback_used: bool = False
    provider_candidates: list[dict[str, Any]] = Field(default_factory=list)
    reason_codes: list[str] = Field(default_factory=list)


class CapabilitySummary(BaseModel):
    """Normalized service, method, or resource capability."""

    capability_id: str
    kind: Literal["service", "method", "resource"]
    module: str | None = None
    service_instance_id: str | None = None
    provider_peer_id: str
    method: str | None = None
    resource_id: str | None = None
    selector: MeshAddressSelector | None = None
    availability: AvailabilityState
    policy_flags: dict[str, bool] = Field(default_factory=dict)
    blockers: list[str] = Field(default_factory=list)
    provenance: dict[str, Any] = Field(default_factory=dict)


class RemoteActionPreflight(BaseModel):
    """Reusable preflight data for remote actions before any execution UI."""

    target_selector: MeshAddressSelector | None = None
    policy_flags: dict[str, bool] = Field(default_factory=dict)
    required_fields: list[str] = Field(default_factory=list)
    availability: AvailabilityState = "pending"
    blockers: list[str] = Field(default_factory=list)
    expected_audit_fields: list[str] = Field(
        default_factory=lambda: ["correlation_id", "peer_id", "status"]
    )
    argument_summary: dict[str, Any] = Field(default_factory=dict)


class ToolSummary(BaseModel):
    """UI-safe Tooling discovery metadata."""

    name: str
    display_name: str
    global_tool_id: str
    provider_peer_id: str
    provider_service_instance_id: str
    execution_location: Literal["local", "remote"]
    source_type: str
    safety_class: str
    required_permissions: list[str] = Field(default_factory=list)
    confirmation_required: bool = False
    availability: AvailabilityState
    preflight: RemoteActionPreflight | None = None


class ToolExecutionSummary(BaseModel):
    """UI-safe Tooling execution result."""

    ok: bool
    status: str | None = None
    availability: AvailabilityState
    error_code: str | None = None
    error: str | None = None
    provider_peer_id: str | None = None
    global_tool_id: str | None = None
    audit: AuditReference = Field(default_factory=AuditReference)


class SchedulerJobSummary(BaseModel):
    """Ownership-aware scheduler job view."""

    job_id: str
    name: str
    namespace: str
    owner_peer_id: str
    owner_principal_id: str
    target_selector: MeshAddressSelector | None = None
    delegated_permissions: list[str] = Field(default_factory=list)
    policy_decision_id: str | None = None
    availability: AvailabilityState = "available-local"
    audit: AuditReference = Field(default_factory=AuditReference)


class DeferredClaim(BaseModel):
    """Backend gap surfaced as explicitly blocked/deferred, not available."""

    claim: str
    status: Literal["blocked", "deferred", "privacy-blocked", "unsupported"]
    required_backend_evidence: str


class MeshStatusView(BaseModel):
    """Normalized mesh status payload for future status/diagnostics screens."""

    local_peer_id: str | None = None
    local_node_name: str = ""
    mesh_enabled: bool = False
    mesh_started: bool = False
    webrtc_started: bool = False
    peers: list[PeerSummary] = Field(default_factory=list)
    routes: list[RouteSummary] = Field(default_factory=list)
    compatibility_failures: list[dict[str, Any]] = Field(default_factory=list)
    secrets_redacted: bool = True


class CapabilityGraphView(BaseModel):
    """Normalized capability graph plus blocked/deferred backend gaps."""

    local_peer_id: str | None = None
    local_node_name: str = ""
    capabilities: list[CapabilitySummary] = Field(default_factory=list)
    provider_index: dict[str, list[str]] = Field(default_factory=dict)
    candidate_provider_index: dict[str, list[str]] = Field(default_factory=dict)
    deferred_claims: list[DeferredClaim] = Field(default_factory=list)
    secrets_redacted: bool = True
