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
