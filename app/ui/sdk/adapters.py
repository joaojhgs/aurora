"""Pure adapters from backend contract models to UI SDK view models."""

from __future__ import annotations

import json
from typing import Any

from pydantic import BaseModel

from app.shared.contracts.models.gateway import (
    CapabilityGraph,
    CapabilityPolicyInfo,
    CapabilityServiceInfo,
    GetMeshStatusResponse,
    MeshRouteDiagnostic,
)
from app.shared.contracts.models.mesh import MeshAddressSelector, MeshPeerInfo, MeshPeerListResponse
from app.shared.contracts.models.scheduler import SchedulerJobInfo, SchedulerListJobsResponse
from app.shared.contracts.models.tooling import (
    ToolingExecuteToolResponse,
    ToolingGetToolsResponse,
    ToolingToolInfo,
)
from app.ui.sdk.models import (
    AuditReference,
    AvailabilityState,
    CapabilityGraphView,
    CapabilitySummary,
    DeferredClaim,
    MeshStatusView,
    PeerSummary,
    RemoteActionPreflight,
    RouteSummary,
    SchedulerJobSummary,
    ToolExecutionSummary,
    ToolSummary,
)
from app.ui.sdk.redaction import redact_sensitive

DEFERRED_CLAIMS: tuple[DeferredClaim, ...] = (
    DeferredClaim(
        claim="raw_sql_across_peers",
        status="blocked",
        required_backend_evidence="Explicitly prohibited by data-sharing policy.",
    ),
    DeferredClaim(
        claim="bidirectional_chat_rag_scheduler_sync",
        status="deferred",
        required_backend_evidence="Domain sync contracts with namespace, conflict, delete, provenance, and tests.",
    ),
    DeferredClaim(
        claim="remote_auth_config_transparent_admin",
        status="blocked",
        required_backend_evidence="Explicit remote-admin policy and permission model.",
    ),
    DeferredClaim(
        claim="remote_microphone_live_listening",
        status="privacy-blocked",
        required_backend_evidence="Consent contract, privacy indicator events, capacity checks, and stream state.",
    ),
    DeferredClaim(
        claim="remote_playback_without_target",
        status="privacy-blocked",
        required_backend_evidence="Explicit peer/device selector, confirmation, and backend playback state.",
    ),
    DeferredClaim(
        claim="dangerous_remote_tool_auto_binding",
        status="blocked",
        required_backend_evidence="Explicit confirmation/resource approval flow and backend decision event.",
    ),
    DeferredClaim(
        claim="pairing_success_from_presence",
        status="blocked",
        required_backend_evidence="Authenticated bilateral trust, manifest negotiation, and stable peer identity.",
    ),
    DeferredClaim(
        claim="tauri_e2e_from_browser_tests",
        status="blocked",
        required_backend_evidence="Native Tauri shell plus backend/native/WebRTC verification harness.",
    ),
)


def normalize_mesh_status(payload: GetMeshStatusResponse | dict[str, Any]) -> MeshStatusView:
    """Normalize Gateway.GetMeshStatus into UI-safe status summaries."""

    status = _model(payload, GetMeshStatusResponse)
    return MeshStatusView(
        local_peer_id=status.local.peer_id,
        local_node_name=status.local.node_name,
        mesh_enabled=status.local.mesh_enabled,
        mesh_started=status.local.mesh_started,
        webrtc_started=status.local.webrtc_started,
        peers=[
            PeerSummary(
                peer_id=peer.peer_id,
                node_name=peer.node_name,
                lifecycle_state=_peer_lifecycle_state(
                    peer.status,
                    peer.last_ping_age_s,
                    peer.last_manifest_age_s,
                ),
                trust_state="backend-proven"
                if peer.status in {"authenticated", "negotiated", "connected"}
                else "pending",
                connection_status=peer.status,
                latency_ms=peer.latency_ms,
                stale_age_s=peer.last_manifest_age_s if peer.status == "stale" else None,
                service_count=len(peer.services),
                last_evidence_source="Gateway.GetMeshStatus",
                reason_codes=_peer_reason_codes(peer.status),
            )
            for peer in status.peers
        ],
        routes=[_route_summary(route) for route in status.routes],
        compatibility_failures=[failure.model_dump() for failure in status.compatibility_failures],
        secrets_redacted=status.secrets_redacted,
    )


def normalize_auth_peers(
    payload: MeshPeerListResponse | list[MeshPeerInfo] | dict[str, Any],
) -> list[PeerSummary]:
    """Normalize Auth mesh peer trust records."""

    if isinstance(payload, dict):
        peers = MeshPeerListResponse.model_validate(payload).peers
    elif isinstance(payload, MeshPeerListResponse):
        peers = payload.peers
    else:
        peers = payload
    return [_auth_peer_summary(peer) for peer in peers]


def normalize_capability_graph(payload: CapabilityGraph | dict[str, Any]) -> CapabilityGraphView:
    """Normalize Gateway.GetCapabilityGraph for capability/status screens."""

    graph = _model(payload, CapabilityGraph)
    capabilities: list[CapabilitySummary] = []
    for service in graph.services:
        capabilities.append(_service_capability(service))
        for method in service.methods:
            capabilities.append(
                CapabilitySummary(
                    capability_id=method.method_id,
                    kind="method",
                    module=method.module,
                    service_instance_id=service.service_instance_id,
                    provider_peer_id=method.address.peer_id,
                    method=method.name,
                    selector=_selector_from_address(method.address.model_dump()),
                    availability=_policy_availability(
                        method.policy,
                        service.routable,
                        service.route_blockers,
                    ),
                    policy_flags=_policy_flags(method.policy),
                    blockers=_policy_blockers(method.policy, service.route_blockers),
                    provenance=method.provenance.model_dump(),
                )
            )
    for resource in graph.resources:
        capabilities.append(
            CapabilitySummary(
                capability_id=resource.resource_id,
                kind="resource",
                module=resource.address.module,
                service_instance_id=resource.service_instance_id,
                provider_peer_id=resource.owner_peer_id,
                resource_id=resource.resource_id,
                selector=_selector_from_address(resource.address.model_dump()),
                availability=_policy_availability(resource.policy, True, []),
                policy_flags=_policy_flags(resource.policy),
                blockers=_policy_blockers(resource.policy, []),
                provenance=resource.provenance.model_dump(),
            )
        )
    return CapabilityGraphView(
        local_peer_id=graph.local_peer_id,
        local_node_name=graph.local_node_name,
        capabilities=capabilities,
        provider_index=graph.provider_index,
        candidate_provider_index=graph.candidate_provider_index,
        deferred_claims=list(DEFERRED_CLAIMS),
        secrets_redacted=graph.secrets_redacted,
    )


def normalize_tools(payload: ToolingGetToolsResponse | dict[str, Any]) -> list[ToolSummary]:
    """Normalize Tooling.GetTools metadata."""

    response = _model(payload, ToolingGetToolsResponse)
    return [_tool_summary(tool) for tool in response.tools]


def normalize_tool_execution(
    payload: ToolingExecuteToolResponse | dict[str, Any],
) -> ToolExecutionSummary:
    """Normalize Tooling.ExecuteTool response without exposing result payloads."""

    response = _model(payload, ToolingExecuteToolResponse)
    availability = _execution_availability(response.status, response.error_code, response.ok)
    return ToolExecutionSummary(
        ok=response.ok,
        status=response.status,
        availability=availability,
        error_code=response.error_code,
        error=response.error,
        provider_peer_id=response.provider_peer_id,
        global_tool_id=response.global_tool_id,
        audit=AuditReference(
            correlation_id=response.correlation_id,
            event_kind="Tooling.ExecuteTool",
            peer_id=response.provider_peer_id,
            tool_id=response.global_tool_id,
            status=response.status,
        ),
    )


def normalize_scheduler_jobs(
    payload: SchedulerListJobsResponse | list[SchedulerJobInfo] | dict[str, Any],
) -> list[SchedulerJobSummary]:
    """Normalize Scheduler.ListJobs ownership/delegation fields."""

    if isinstance(payload, dict):
        jobs = SchedulerListJobsResponse.model_validate(payload).jobs
    elif isinstance(payload, SchedulerListJobsResponse):
        jobs = payload.jobs
    else:
        jobs = payload
    return [
        SchedulerJobSummary(
            job_id=job.job_id,
            name=job.name,
            namespace=job.namespace,
            owner_peer_id=job.owner_peer_id,
            owner_principal_id=job.owner_principal_id,
            target_selector=MeshAddressSelector(
                peer_id=job.target_peer_id,
                resource_namespace=job.target_resource_namespace,
            )
            if job.target_peer_id or job.target_resource_namespace
            else None,
            delegated_permissions=job.delegated_permissions,
            policy_decision_id=job.policy_decision_id,
            availability="available-remote" if job.target_peer_id else "available-local",
            audit=AuditReference(
                correlation_id=job.correlation_id,
                event_kind="Scheduler.Job",
                peer_id=job.target_peer_id or job.owner_peer_id,
                status=job.status,
            ),
        )
        for job in jobs
    ]


def normalize_audit_events(events: list[dict[str, Any]]) -> list[AuditReference]:
    """Normalize Auth audit rows and redact details."""

    return [_audit_reference(event) for event in events]


def _model(payload: BaseModel | dict[str, Any], model_type: type[BaseModel]) -> Any:
    if isinstance(payload, model_type):
        return payload
    return model_type.model_validate(payload)


def _route_summary(route: MeshRouteDiagnostic) -> RouteSummary:
    reason_codes = [provider.reason_code for provider in route.providers if provider.reason_code]
    fallback_used = (
        route.decision_target == "local"
        and route.prefer.startswith("network")
        and route.fallback == "local"
    )
    return RouteSummary(
        module=route.module,
        availability=_route_availability(route, fallback_used),
        decision_target=route.decision_target,
        provider_peer_id=route.decision_peer_id,
        reason=route.reason,
        fallback=route.fallback,
        fallback_used=fallback_used,
        provider_candidates=[
            {
                "peer_id": provider.peer_id,
                "node_name": provider.node_name,
                "eligible": provider.eligible,
                "reason_code": provider.reason_code,
                "reason": provider.reason,
            }
            for provider in route.providers
        ],
        reason_codes=reason_codes,
    )


def _route_availability(route: MeshRouteDiagnostic, fallback_used: bool) -> AvailabilityState:
    if route.decision_target == "remote":
        return "available-remote"
    if route.decision_target == "local":
        return "degraded" if fallback_used else "available-local"
    if route.decision_target == "none":
        return "no-route"
    return "hard-failure"


def _peer_lifecycle_state(status: str, ping_age: float | None, manifest_age: float | None) -> str:
    if status == "stale" or (manifest_age is not None and manifest_age > 120):
        return "stale"
    if status == "denied":
        return "denied"
    if status in {"pending", "connecting"}:
        return "pending"
    if status in {"error", "failed"}:
        return "hard-failure"
    if ping_age is not None and ping_age > 60:
        return "degraded"
    return "backend-proven"


def _peer_reason_codes(status: str) -> list[str]:
    if status in {"stale", "denied", "pending", "error", "failed"}:
        return [status]
    return []


def _auth_peer_summary(peer: MeshPeerInfo) -> PeerSummary:
    trust_state = _trust_state(peer.outbound_status, peer.inbound_status)
    return PeerSummary(
        peer_id=peer.peer_id,
        node_name=peer.node_name,
        lifecycle_state="backend-proven" if peer.connection_status == "connected" else "degraded",
        trust_state=trust_state,
        connection_status=peer.connection_status,
        outbound_status=peer.outbound_status,
        inbound_status=peer.inbound_status,
        last_evidence_source="Auth.MeshListPeers",
        reason_codes=[
            state
            for state in (peer.outbound_status, peer.inbound_status)
            if state in {"pending", "denied"}
        ],
    )


def _trust_state(outbound: str, inbound: str) -> str:
    if "denied" in {outbound, inbound}:
        return "denied"
    if outbound == "approved" and inbound == "approved":
        return "backend-proven"
    if "pending" in {outbound, inbound} or "unknown" in {outbound, inbound}:
        return "pending"
    return "degraded"


def _service_capability(service: CapabilityServiceInfo) -> CapabilitySummary:
    return CapabilitySummary(
        capability_id=service.service_instance_id,
        kind="service",
        module=service.module,
        service_instance_id=service.service_instance_id,
        provider_peer_id=service.peer_id,
        selector=_selector_from_address(service.address.model_dump()),
        availability=_policy_availability(service.policy, service.routable, service.route_blockers),
        policy_flags=_policy_flags(service.policy),
        blockers=_policy_blockers(service.policy, service.route_blockers),
        provenance=service.provenance.model_dump(),
    )


def _policy_flags(policy: CapabilityPolicyInfo) -> dict[str, bool]:
    return {
        "explicit_selector_required": policy.explicit_selector_required,
        "confirmation_required": policy.confirmation_required,
        "consent_required": policy.consent_required,
        "privacy_indicator_required": policy.privacy_indicator_required,
        "bandwidth_check_required": policy.bandwidth_check_required,
        "local_only": policy.local_only,
    }


def _policy_blockers(policy: CapabilityPolicyInfo, route_blockers: list[str]) -> list[str]:
    blockers = list(route_blockers)
    for field, required in _policy_flags(policy).items():
        if required and field != "local_only":
            blockers.append(field)
    if policy.local_only:
        blockers.append("local_only")
    return blockers


def _policy_availability(
    policy: CapabilityPolicyInfo,
    routable: bool,
    route_blockers: list[str],
) -> AvailabilityState:
    if "stale" in route_blockers or "peer_stale" in route_blockers:
        return "stale"
    if any("denied" in blocker or "unauthorized" in blocker for blocker in route_blockers):
        return "denied"
    if policy.consent_required or policy.privacy_indicator_required:
        return "privacy-blocked"
    if policy.explicit_selector_required or policy.confirmation_required:
        return "pending"
    if not routable:
        return "no-route"
    return "available-local" if policy.local_only else "available-remote"


def _tool_summary(tool: ToolingToolInfo) -> ToolSummary:
    policy_flags = {
        "confirmation_required": tool.confirmation_required,
        "explicit_selector_required": tool.execution_location == "remote",
        "resource_selector_required": tool.safety_class in {"sensitive", "dangerous"},
    }
    blockers = [
        field
        for field, required in policy_flags.items()
        if required and field != "explicit_selector_required"
    ]
    availability: AvailabilityState = "available-local"
    if tool.execution_location == "remote":
        availability = "pending" if blockers else "available-remote"
    return ToolSummary(
        name=tool.name,
        display_name=tool.display_name,
        global_tool_id=tool.global_tool_id,
        provider_peer_id=tool.provider_peer_id,
        provider_service_instance_id=tool.provider_service_instance_id,
        execution_location=tool.execution_location,
        source_type=tool.source_type,
        safety_class=tool.safety_class,
        required_permissions=tool.required_permissions,
        confirmation_required=tool.confirmation_required,
        availability=availability,
        preflight=RemoteActionPreflight(
            target_selector=MeshAddressSelector(
                peer_id=tool.provider_peer_id,
                service_instance_id=tool.provider_service_instance_id,
                tool_id=tool.global_tool_id,
            ),
            policy_flags=policy_flags,
            required_fields=blockers,
            availability=availability,
            blockers=blockers,
            expected_audit_fields=["correlation_id", "peer_id", "tool_id", "status"],
        )
        if tool.execution_location == "remote"
        else None,
    )


def _execution_availability(
    status: str | None, error_code: str | None, ok: bool
) -> AvailabilityState:
    if ok and status in {"success", "dry_run"}:
        return "available-remote"
    if status == "denied" or (error_code and "denied" in error_code):
        return "denied"
    if error_code in {"no_route", "network_no_provider"}:
        return "no-route"
    if error_code in {"privacy_blocked", "consent_required", "confirmation_missing"}:
        return "privacy-blocked"
    return "hard-failure"


def _selector_from_address(address: dict[str, Any]) -> MeshAddressSelector:
    return MeshAddressSelector(
        peer_id=address.get("peer_id"),
        service_instance_id=address.get("service_instance_id"),
        resource_namespace=address.get("namespace"),
        tool_id=address.get("tool_id"),
    )


def _audit_reference(event: dict[str, Any]) -> AuditReference:
    details = _parse_details(event.get("details"))
    return AuditReference(
        correlation_id=event.get("correlation_id") or details.get("correlation_id"),
        event_kind=str(event.get("event") or event.get("event_kind") or ""),
        peer_id=event.get("peer_id") or details.get("peer_id") or details.get("target_peer_id"),
        method=details.get("method"),
        tool_id=details.get("tool_id") or details.get("global_tool_id"),
        resource_id=details.get("resource_id"),
        status=event.get("status") or details.get("status"),
        details_redacted=redact_sensitive(details),
    )


def _parse_details(details: Any) -> dict[str, Any]:
    if isinstance(details, dict):
        return details
    if isinstance(details, str) and details:
        try:
            parsed = json.loads(details)
        except json.JSONDecodeError:
            return {"message": details}
        return parsed if isinstance(parsed, dict) else {"value": parsed}
    return {}
