"""Gateway module for HTTP API access to Aurora services.

The Gateway provides:
- FastAPI-based HTTP API for external access
- Dynamic route generation from contract registry
- Service discovery via announcement protocol
- Works in both thread and process modes
"""

from app.services.gateway.fastapi_app import create_gateway_app
from app.services.gateway.registry_aggregator import RegistryAggregator
from app.services.gateway.route_generator import RouteGenerator

__all__ = [
    "create_gateway_app",
    "RegistryAggregator",
    "RouteGenerator",
]

