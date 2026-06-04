"""Common/shared contract models used across multiple services."""

from app.shared.contracts.registry import IOModel


class EmptyInput(IOModel):
    """Empty input model for methods that take no parameters."""

    pass


class EmptyOutput(IOModel):
    """Empty output model for fire-and-forget methods."""

    pass


class ErrorOutput(IOModel):
    """Standard error response model."""

    error: str
    code: str | None = None


class HealthCheckResponse(IOModel):
    """Health check response model."""

    status: str  # "healthy" | "degraded" | "unhealthy"
    checks: dict[str, str]
    timestamp: str
    service: str
