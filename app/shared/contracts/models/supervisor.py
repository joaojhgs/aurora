"""Supervisor service contract models."""

from typing import Any, Literal

from pydantic import BaseModel, Field

from app.shared.contracts.registry import IOModel


# Module identifiers
class SupervisorModule:
    """Module identifier for Supervisor service."""

    NAME = "Supervisor"


# Method identifiers
class SupervisorMethods:
    """Full method identifiers for Supervisor service."""

    GET_STATUS = f"{SupervisorModule.NAME}.GetStatus"
    RESTART_SERVICE = f"{SupervisorModule.NAME}.RestartService"
    STOP_SERVICE = f"{SupervisorModule.NAME}.StopService"
    START_SERVICE = f"{SupervisorModule.NAME}.StartService"
    HEALTH = f"{SupervisorModule.NAME}.Health"
    HEALTH_CHECK = f"{SupervisorModule.NAME}.HealthCheck"


class ServiceStatus(BaseModel):
    """Status of a single service."""

    name: str
    running: bool
    uptime_seconds: float = 0.0
    details: dict[str, Any] = Field(default_factory=dict)
    controls: dict[str, "ServiceControlAvailability"] = Field(default_factory=dict)


class ServiceControlAvailability(IOModel):
    """Machine-readable availability for a Supervisor service control."""

    operation: Literal["restart", "stop", "start"]
    method_id: str
    supported: bool = False
    state: Literal["available", "unsupported", "internal_only"] = "internal_only"
    exposure: Literal["internal", "external", "both"] = "internal"
    method_type: Literal["manage"] = "manage"
    required_perms: list[str] = Field(default_factory=list)
    admin_action_required: bool = True
    reason: str = ""


class GetStatusResponse(IOModel):
    """Response containing status of all services."""

    services: list[ServiceStatus]
    mode: str  # "threads" or "processes"
    control_capabilities: list[ServiceControlAvailability] = Field(default_factory=list)


class ServiceControlCommand(IOModel):
    """Command to control a service (start/stop/restart)."""

    service_name: str
    reason: str | None = None


class ServiceControlResponse(IOModel):
    """Response to service control command."""

    success: bool
    message: str | None = None
    operation: Literal["restart", "stop", "start"] | None = None
    service_name: str | None = None
    status: Literal["accepted", "unsupported", "internal_only", "not_found"] = "unsupported"
    control_state: Literal["available", "unsupported", "internal_only"] = "internal_only"
    admin_action_required: bool = True
