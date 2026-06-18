"""Production mesh diagnostics view models for Aurora UI surfaces."""

from __future__ import annotations

from collections import Counter
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.ui.sdk.models import (
    AuditReference,
    AvailabilityState,
    CapabilityGraphView,
    CapabilitySummary,
    MeshStatusView,
    PeerSummary,
    RouteSummary,
)
from app.ui.sdk.redaction import redact_sensitive

MeshDiagnosticsState = Literal[
    "loading",
    "empty",
    "connected",
    "degraded",
    "stale",
    "denied",
    "fallback",
    "hard-failure",
]


class MeshDiagnosticsAction(BaseModel):
    """Keyboard-discoverable read-only UI action metadata."""

    action_id: str
    label: str
    aria_label: str
    target_section_id: str


class MeshDiagnosticsSection(BaseModel):
    """Navigable diagnostics section for PyQt, web, and future Tauri clients."""

    section_id: str
    title: str
    state: MeshDiagnosticsState | AvailabilityState
    aria_label: str
    summary: str
    items: list[dict[str, Any]] = Field(default_factory=list)
    actions: list[MeshDiagnosticsAction] = Field(default_factory=list)


class ProviderStatusSummary(BaseModel):
    """Candidate versus eligible provider counts and reason-code details."""

    module: str
    candidate_count: int = 0
    eligible_count: int = 0
    denied_count: int = 0
    stale_count: int = 0
    capacity_limited_count: int = 0
    privacy_blocked_count: int = 0
    reason_codes: list[str] = Field(default_factory=list)
    candidates: list[dict[str, Any]] = Field(default_factory=list)


class MeshDiagnosticsSurface(BaseModel):
    """Complete read-only mesh diagnostics payload for current and future UI shells."""

    state: MeshDiagnosticsState
    title: str = "Mesh diagnostics"
    aria_live: Literal["polite"] = "polite"
    focus_order: list[str] = Field(default_factory=list)
    sections: list[MeshDiagnosticsSection] = Field(default_factory=list)
    provider_status: list[ProviderStatusSummary] = Field(default_factory=list)
    audit_references: list[AuditReference] = Field(default_factory=list)
    secrets_redacted: bool = True
    diagnostics: dict[str, Any] = Field(default_factory=dict)


def build_loading_mesh_diagnostics() -> MeshDiagnosticsSurface:
    """Return the loading state used before Gateway/Auth data arrives."""

    return MeshDiagnosticsSurface(
        state="loading",
        focus_order=["mesh-local"],
        sections=[
            MeshDiagnosticsSection(
                section_id="mesh-local",
                title="Local mesh",
                state="loading",
                aria_label="Mesh diagnostics loading",
                summary="Waiting for Gateway mesh diagnostics.",
            )
        ],
    )


def build_mesh_diagnostics_surface(
    mesh_status: MeshStatusView | None,
    capability_graph: CapabilityGraphView | None = None,
    auth_peers: list[PeerSummary] | None = None,
    audit_references: list[AuditReference] | None = None,
) -> MeshDiagnosticsSurface:
    """Build a production-safe diagnostics surface from backend-normalized data."""

    if mesh_status is None:
        return build_loading_mesh_diagnostics()

    merged_peers = _merge_peer_evidence(mesh_status.peers, auth_peers or [])
    safe_audit_references = _redacted_audit_references(audit_references or [])
    provider_status = _provider_status(mesh_status.routes, capability_graph)
    sections = [
        _local_section(mesh_status),
        _peer_section(merged_peers),
        _route_section(mesh_status.routes),
        _provider_section(provider_status),
        _diagnostics_section(mesh_status, safe_audit_references),
    ]
    sections = [
        section for section in sections if section.items or section.section_id == "mesh-local"
    ]
    focus_order = [section.section_id for section in sections]

    return MeshDiagnosticsSurface(
        state=_surface_state(mesh_status, merged_peers),
        focus_order=focus_order,
        sections=sections,
        provider_status=provider_status,
        audit_references=safe_audit_references,
        secrets_redacted=mesh_status.secrets_redacted
        and (capability_graph.secrets_redacted if capability_graph else True),
        diagnostics=redact_sensitive(
            {
                "compatibility_failures": mesh_status.compatibility_failures,
                "deferred_claims": [
                    claim.model_dump() for claim in capability_graph.deferred_claims
                ]
                if capability_graph
                else [],
            }
        ),
    )


def _merge_peer_evidence(
    gateway_peers: list[PeerSummary], auth_peers: list[PeerSummary]
) -> list[PeerSummary]:
    peers_by_id = {peer.peer_id: peer.model_copy(deep=True) for peer in gateway_peers}
    for auth_peer in auth_peers:
        existing = peers_by_id.get(auth_peer.peer_id)
        if existing is None:
            peers_by_id[auth_peer.peer_id] = auth_peer.model_copy(deep=True)
            continue
        existing.trust_state = auth_peer.trust_state
        existing.outbound_status = auth_peer.outbound_status
        existing.inbound_status = auth_peer.inbound_status
        existing.reason_codes = sorted(set(existing.reason_codes + auth_peer.reason_codes))
        existing.last_evidence_source = (
            f"{existing.last_evidence_source}+{auth_peer.last_evidence_source}"
        )
    return list(peers_by_id.values())


def _redacted_audit_references(audit_references: list[AuditReference]) -> list[AuditReference]:
    return [
        reference.model_copy(
            update={"details_redacted": redact_sensitive(reference.details_redacted)}
        )
        for reference in audit_references
    ]


def _surface_state(mesh_status: MeshStatusView, peers: list[PeerSummary]) -> MeshDiagnosticsState:
    if not mesh_status.mesh_enabled or (not peers and not mesh_status.routes):
        return "empty"
    if any(route.availability == "hard-failure" for route in mesh_status.routes):
        return "hard-failure"
    if any(peer.trust_state == "denied" for peer in peers) or any(
        route.availability == "denied" for route in mesh_status.routes
    ):
        return "denied"
    if any(peer.lifecycle_state == "stale" for peer in peers) or any(
        route.availability == "stale" for route in mesh_status.routes
    ):
        return "stale"
    if any(route.fallback_used for route in mesh_status.routes):
        return "fallback"
    if any(peer.lifecycle_state in {"degraded", "hard-failure"} for peer in peers) or any(
        route.availability in {"degraded", "no-route", "privacy-blocked"}
        for route in mesh_status.routes
    ):
        return "degraded"
    return "connected"


def _local_section(mesh_status: MeshStatusView) -> MeshDiagnosticsSection:
    state: MeshDiagnosticsState = "connected" if mesh_status.mesh_started else "empty"
    summary = "Mesh is disabled."
    if mesh_status.mesh_enabled and mesh_status.mesh_started:
        summary = "Local mesh runtime is started from Gateway evidence."
    elif mesh_status.mesh_enabled:
        summary = "Mesh is enabled but not started."
    return MeshDiagnosticsSection(
        section_id="mesh-local",
        title="Local mesh",
        state=state,
        aria_label="Local mesh status",
        summary=summary,
        items=[
            {
                "peer_id": mesh_status.local_peer_id,
                "node_name": mesh_status.local_node_name,
                "mesh_enabled": mesh_status.mesh_enabled,
                "mesh_started": mesh_status.mesh_started,
                "webrtc_started": mesh_status.webrtc_started,
                "evidence": "Gateway.GetMeshStatus.local",
            }
        ],
        actions=[_details_action("mesh-local")],
    )


def _peer_section(peers: list[PeerSummary]) -> MeshDiagnosticsSection:
    counts = Counter(peer.lifecycle_state for peer in peers)
    trust_counts = Counter(peer.trust_state for peer in peers)
    return MeshDiagnosticsSection(
        section_id="mesh-peers",
        title="Known peers",
        state=_worst_peer_state(peers),
        aria_label="Known mesh peers and trust state",
        summary=(
            f"{len(peers)} peer(s), {trust_counts.get('denied', 0)} denied, "
            f"{counts.get('stale', 0)} stale."
        ),
        items=[
            redact_sensitive(
                {
                    "peer_id": peer.peer_id,
                    "node_name": peer.node_name,
                    "lifecycle_state": peer.lifecycle_state,
                    "trust_state": peer.trust_state,
                    "connection_status": peer.connection_status,
                    "outbound_status": peer.outbound_status,
                    "inbound_status": peer.inbound_status,
                    "latency_ms": peer.latency_ms,
                    "stale_age_s": peer.stale_age_s,
                    "service_count": peer.service_count,
                    "reason_codes": peer.reason_codes,
                    "evidence": peer.last_evidence_source,
                }
            )
            for peer in peers
        ],
        actions=[_details_action("mesh-peers")],
    )


def _route_section(routes: list[RouteSummary]) -> MeshDiagnosticsSection:
    return MeshDiagnosticsSection(
        section_id="mesh-routes",
        title="Route health",
        state=_worst_route_state(routes),
        aria_label="Mesh route health and fallback state",
        summary=f"{len(routes)} route(s) reported by Gateway.",
        items=[
            redact_sensitive(
                {
                    "module": route.module,
                    "availability": route.availability,
                    "decision_target": route.decision_target,
                    "provider_peer_id": route.provider_peer_id,
                    "fallback": route.fallback,
                    "fallback_used": route.fallback_used,
                    "reason": route.reason,
                    "reason_codes": route.reason_codes,
                    "evidence": "Gateway.GetMeshStatus.routes",
                }
            )
            for route in routes
        ],
        actions=[_details_action("mesh-routes")],
    )


def _provider_section(
    provider_status: list[ProviderStatusSummary],
) -> MeshDiagnosticsSection:
    return MeshDiagnosticsSection(
        section_id="mesh-providers",
        title="Provider candidates",
        state=_provider_section_state(provider_status),
        aria_label="Provider candidates and eligible providers",
        summary=f"{len(provider_status)} module provider set(s).",
        items=[status.model_dump() for status in provider_status],
        actions=[_details_action("mesh-providers")],
    )


def _diagnostics_section(
    mesh_status: MeshStatusView, audit_references: list[AuditReference]
) -> MeshDiagnosticsSection:
    return MeshDiagnosticsSection(
        section_id="mesh-diagnostics",
        title="Diagnostics",
        state="connected" if mesh_status.secrets_redacted else "degraded",
        aria_label="Redacted mesh diagnostics and audit references",
        summary="Sensitive values are redacted before display.",
        items=[
            redact_sensitive(
                {
                    "secrets_redacted": mesh_status.secrets_redacted,
                    "compatibility_failures": mesh_status.compatibility_failures,
                    "audit_references": [reference.model_dump() for reference in audit_references],
                }
            )
        ],
        actions=[_details_action("mesh-diagnostics")],
    )


def _provider_status(
    routes: list[RouteSummary],
    capability_graph: CapabilityGraphView | None,
) -> list[ProviderStatusSummary]:
    graph_capabilities = capability_graph.capabilities if capability_graph else []
    by_module: dict[str, list[CapabilitySummary]] = {}
    for capability in graph_capabilities:
        if capability.module:
            by_module.setdefault(capability.module, []).append(capability)

    summaries: list[ProviderStatusSummary] = []
    for route in routes:
        candidates = [
            redact_sensitive(candidate) for candidate in route.provider_candidates
        ]
        route_reason_codes = [
            str(candidate.get("reason_code"))
            for candidate in candidates
            if candidate.get("reason_code")
        ]
        graph_candidates = by_module.get(route.module, [])
        graph_reason_codes = [
            blocker
            for capability in graph_candidates
            for blocker in capability.blockers
        ]
        eligible_count = sum(1 for candidate in candidates if candidate.get("eligible"))
        if not candidates and capability_graph:
            eligible_ids = set(capability_graph.provider_index.get(route.module, []))
            candidate_ids = capability_graph.candidate_provider_index.get(route.module, [])
            eligible_count = len(eligible_ids)
            candidates = [
                {
                    "service_instance_id": candidate_id,
                    "eligible": candidate_id in eligible_ids,
                    "evidence": "Gateway.GetCapabilityGraph.candidate_provider_index",
                }
                for candidate_id in candidate_ids
            ]
        reason_codes = sorted(set(route_reason_codes + graph_reason_codes))
        summaries.append(
            ProviderStatusSummary(
                module=route.module,
                candidate_count=len(candidates),
                eligible_count=eligible_count,
                denied_count=_count_reasons(candidates, reason_codes, "denied", "unauthorized"),
                stale_count=_count_reasons(candidates, reason_codes, "stale"),
                capacity_limited_count=_count_reasons(
                    candidates, reason_codes, "capacity", "at_capacity"
                ),
                privacy_blocked_count=_count_reasons(
                    candidates, reason_codes, "privacy", "consent"
                ),
                reason_codes=reason_codes,
                candidates=candidates,
            )
        )
    return summaries


def _count_reasons(
    candidates: list[dict[str, Any]], reason_codes: list[str], *fragments: str
) -> int:
    count = 0
    for candidate in candidates:
        reason = " ".join(
            str(candidate.get(field, "")) for field in ("reason_code", "reason")
        ).lower()
        if any(fragment in reason for fragment in fragments):
            count += 1
    if count:
        return count
    return sum(
        1 for code in reason_codes if any(fragment in code.lower() for fragment in fragments)
    )


def _worst_peer_state(peers: list[PeerSummary]) -> MeshDiagnosticsState:
    states = [peer.trust_state for peer in peers] + [peer.lifecycle_state for peer in peers]
    if "denied" in states:
        return "denied"
    if "hard-failure" in states:
        return "hard-failure"
    if "stale" in states:
        return "stale"
    if "degraded" in states or "pending" in states:
        return "degraded"
    return "connected" if peers else "empty"


def _worst_route_state(routes: list[RouteSummary]) -> MeshDiagnosticsState:
    if any(route.availability == "hard-failure" for route in routes):
        return "hard-failure"
    if any(route.fallback_used for route in routes):
        return "fallback"
    if any(route.availability == "denied" for route in routes):
        return "denied"
    if any(route.availability == "stale" for route in routes):
        return "stale"
    if any(route.availability in {"degraded", "no-route", "privacy-blocked"} for route in routes):
        return "degraded"
    return "connected" if routes else "empty"


def _provider_section_state(
    provider_status: list[ProviderStatusSummary],
) -> MeshDiagnosticsState:
    if not provider_status:
        return "empty"
    if any(status.denied_count for status in provider_status):
        return "denied"
    if any(status.stale_count for status in provider_status):
        return "stale"
    if any(status.capacity_limited_count or status.privacy_blocked_count for status in provider_status):
        return "degraded"
    return "connected"


def _details_action(section_id: str) -> MeshDiagnosticsAction:
    return MeshDiagnosticsAction(
        action_id=f"{section_id}.details",
        label="Details",
        aria_label=f"Show {section_id.replace('-', ' ')} details",
        target_section_id=section_id,
    )
