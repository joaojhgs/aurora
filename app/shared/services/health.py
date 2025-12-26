"""Health check utilities for services."""

from typing import Any

from app.shared.messaging.bus_init import get_bus_singleton


async def check_service_health(service_name: str) -> dict[str, Any]:
    """Check health of a remote service.

    Args:
        service_name: Name of the service to check (e.g., "Config", "DB")

    Returns:
        Health check response dictionary:
        {
            "status": "healthy" | "degraded" | "unhealthy",
            "checks": {...},
            "timestamp": "...",
            "service": "..."
        }
    """
    try:
        bus = get_bus_singleton()

        # Request health check from service
        from app.shared.contracts.models.common import HealthCheckResponse

        # Determine topic based on service name
        topic = f"{service_name}.HealthCheck"

        result = await bus.request(topic, {}, timeout=5.0)

        if result.ok and result.data:
            if hasattr(result.data, "model_dump"):
                return result.data.model_dump()
            elif isinstance(result.data, dict):
                return result.data
            else:
                # Try to convert to dict
                return {
                    "status": "healthy" if hasattr(result.data, "status") else "unknown",
                    "service": service_name,
                    "data": str(result.data),
                }
        else:
            return {
                "status": "unhealthy",
                "error": result.error or "Unknown error",
                "service": service_name,
            }
    except Exception as e:
        return {
            "status": "unhealthy",
            "error": str(e),
            "service": service_name,
        }
