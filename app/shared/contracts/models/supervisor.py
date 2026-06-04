"""Supervisor service contract models."""

from typing import Any

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


class GetStatusResponse(IOModel):
    """Response containing status of all services."""

    services: list[ServiceStatus]
    mode: str  # "threads" or "processes"


class ServiceControlCommand(IOModel):
    """Command to control a service (start/stop/restart)."""

    service_name: str
    reason: str | None = None


class ServiceControlResponse(IOModel):
    """Response to service control command."""

    success: bool
    message: str | None = None
