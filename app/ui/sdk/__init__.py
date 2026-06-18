"""Typed UI SDK adapters over Aurora backend contract models."""

from app.ui.mesh_diagnostics import (
    MeshDiagnosticsAction,
    MeshDiagnosticsSection,
    MeshDiagnosticsSurface,
    ProviderStatusSummary,
    build_loading_mesh_diagnostics,
    build_mesh_diagnostics_surface,
)
from app.ui.sdk.adapters import (
    normalize_audit_events,
    normalize_auth_peers,
    normalize_capability_graph,
    normalize_mesh_status,
    normalize_scheduler_jobs,
    normalize_tool_execution,
    normalize_tools,
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
from app.ui.sdk.redaction import redact_sensitive, summarize_arguments

__all__ = [
    "AuditReference",
    "AvailabilityState",
    "CapabilityGraphView",
    "CapabilitySummary",
    "DeferredClaim",
    "MeshStatusView",
    "PeerSummary",
    "RemoteActionPreflight",
    "RouteSummary",
    "SchedulerJobSummary",
    "ToolExecutionSummary",
    "ToolSummary",
    "MeshDiagnosticsAction",
    "MeshDiagnosticsSection",
    "MeshDiagnosticsSurface",
    "ProviderStatusSummary",
    "build_loading_mesh_diagnostics",
    "build_mesh_diagnostics_surface",
    "normalize_audit_events",
    "normalize_auth_peers",
    "normalize_capability_graph",
    "normalize_mesh_status",
    "normalize_scheduler_jobs",
    "normalize_tool_execution",
    "normalize_tools",
    "redact_sensitive",
    "summarize_arguments",
]
