"""Gateway module for HTTP API access to Aurora services.

The Gateway provides:
- FastAPI-based HTTP API for external access
- Dynamic route generation from contract registry
- Service discovery via announcement protocol
- Works in both thread and process modes

Heavy imports (FastAPI) are lazy so ``GatewayService`` can be imported in
environments without optional gateway dependencies (e.g. minimal unit tests).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

__all__ = [
    "create_gateway_app",
    "RegistryAggregator",
    "RouteGenerator",
    "GatewayService",
]

if TYPE_CHECKING:
    from app.services.gateway.fastapi_app import create_gateway_app
    from app.services.gateway.registry_aggregator import RegistryAggregator
    from app.services.gateway.route_generator import RouteGenerator
    from app.services.gateway.service import GatewayService


def __getattr__(name: str) -> Any:
    if name == "create_gateway_app":
        from app.services.gateway.fastapi_app import create_gateway_app

        return create_gateway_app
    if name == "RegistryAggregator":
        from app.services.gateway.registry_aggregator import RegistryAggregator

        return RegistryAggregator
    if name == "RouteGenerator":
        from app.services.gateway.route_generator import RouteGenerator

        return RouteGenerator
    if name == "GatewayService":
        from app.services.gateway.service import GatewayService

        return GatewayService
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
