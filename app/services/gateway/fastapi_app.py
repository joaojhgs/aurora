"""FastAPI Application Factory for Aurora Gateway.

Creates and configures the FastAPI application with:
- Dynamic service routes from contract registry
- Standard endpoints (health, registry, services)
- CORS middleware
- Error handling
"""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING, Annotated, Any

from fastapi import Body, Depends, FastAPI, HTTPException, Request, Security
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.helpers.aurora_logger import log_error, log_info
from app.services.gateway.auth import check_auth_enabled
from app.services.gateway.auth_service import AuthService
from app.services.gateway.dependencies import get_auth_service
from app.services.gateway.schemas.auth import (
    PairingApproveRequest,
    PairingApproveResponse,
    PairingConnectResponse,
    PairingExchangeRequest,
    PairingExchangeResponse,
    PairingStartRequest,
    PairingStartResponse,
)

if TYPE_CHECKING:
    from app.messaging.bus import MessageBus
    from app.services.gateway.registry_aggregator import RegistryAggregator


def create_gateway_app(
    bus: MessageBus,
    registry: RegistryAggregator,
    cors_origins: list[str] | None = None,
    cors_allow_credentials: bool = True,
    auth_enabled: bool = False,
    auth_api_keys: list[str] | None = None,
    auth_service: AuthService | None = None,
    title: str = "Aurora Gateway API",
    version: str = "1.0.0",
    request_timeout: float = 30.0,
) -> Any:
    """Create and configure the FastAPI application.

    Args:
        bus: Message bus instance
        registry: Registry aggregator instance
        cors_origins: List of allowed CORS origins (default: ["*"])
        cors_allow_credentials: Whether to allow credentials in CORS (default: True)
        auth_enabled: Whether to enable API key authentication (default: False)
        auth_api_keys: List of valid API keys (default: [])
        auth_service: Auth service instance
        title: API title for OpenAPI docs
        version: API version
        request_timeout: Default timeout for service requests

    Returns:
        FastAPI application instance
    """
    from app.services.gateway.route_generator import RouteGenerator
    from app.shared.contracts.models.common import EmptyInput
    from app.shared.contracts.models.gateway import (
        GetRegistryResponse,
        GetRoutesResponse,
        GetServiceHealthRequest,
        GetServiceHealthResponse,
        GetServicesResponse,
        HealthCheckResponse,
        ModuleRegistryInfo,
        ServiceCountInfo,
        ServiceDetailsResponse,
        ServiceRoutes,
    )

    # Create FastAPI app
    app = FastAPI(
        title=title,
        version=version,
        description="Aurora Voice Assistant HTTP Gateway API.\n\n"
        "This API provides HTTP access to Aurora services via the message bus.\n"
        "Routes are dynamically generated from the contract registry.",
        docs_url="/api/docs",
        redoc_url="/api/redoc",
        openapi_url="/api/openapi.json",
    )

    # Add CORS middleware
    if cors_origins is None:
        cors_origins = ["*"]

    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=cors_allow_credentials,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Add authentication middleware if enabled
    if auth_enabled:
        from app.services.gateway.auth import GatewayAuth, create_auth_middleware
        from app.services.gateway.dependencies import set_gateway_auth

        gateway_auth = GatewayAuth(
            auth_service=auth_service,
            enabled=True,
            api_keys=auth_api_keys or [],
        )
        set_gateway_auth(gateway_auth)
        auth_middleware = create_auth_middleware(gateway_auth)
        app.middleware("http")(auth_middleware)
        log_info("Gateway authentication enabled")

    # Create route generator
    route_generator = RouteGenerator(
        bus=bus,
        registry=registry,
        request_timeout=request_timeout,
    )

    # Store references for lifecycle management
    app.state.bus = bus
    app.state.registry = registry
    app.state.route_generator = route_generator

    # ==========================================================================
    # Startup/Shutdown Events
    # ==========================================================================

    @app.on_event("startup")
    async def startup_event():
        """Initialize gateway components on startup."""
        log_info("Gateway API starting up...")

        # Start registry aggregator
        await registry.start()

        # Create dynamic router and start route generator
        from fastapi import APIRouter

        dynamic_router = APIRouter()
        route_generator.set_router(dynamic_router)
        await route_generator.start()

        # Mount dynamic router
        app.include_router(dynamic_router)

        log_info("Gateway API started successfully")

    @app.on_event("shutdown")
    async def shutdown_event():
        """Cleanup on shutdown."""
        log_info("Gateway API shutting down...")
        await route_generator.stop()
        await registry.stop()
        log_info("Gateway API shutdown complete")

    # ==========================================================================
    # Standard Endpoints
    # ==========================================================================

    @app.get(
        "/api/health",
        tags=["Gateway"],
        summary="Gateway health check",
        response_model=HealthCheckResponse,
    )
    async def health_check() -> HealthCheckResponse:
        """Check gateway health status."""
        services = await registry.get_services()
        healthy_count = sum(1 for s in services if s.status == "healthy")

        return HealthCheckResponse(
            status="healthy" if healthy_count > 0 else "degraded",
            timestamp=datetime.utcnow().isoformat(),
            gateway="up",
            services=ServiceCountInfo(
                total=len(services),
                healthy=healthy_count,
            ),
            routes=route_generator.get_route_count(),
        )

    @app.get(
        "/api/registry",
        tags=["Gateway"],
        summary="Get aggregated service registry",
        response_model=GetRegistryResponse,
    )
    async def get_registry() -> GetRegistryResponse:
        """Get the aggregated registry of all available services and methods."""
        export = await registry.get_registry_export()
        return GetRegistryResponse(
            modules=export["modules"],
            digest=export["digest"],
            service_count=export["service_count"],
            method_count=export["method_count"],
        )

    @app.get(
        "/api/services",
        tags=["Gateway"],
        summary="List available services",
        response_model=GetServicesResponse,
    )
    async def list_services() -> GetServicesResponse:
        """Get list of all known services with their status."""
        import os

        services = await registry.get_services()
        mode = os.getenv("AURORA_ARCHITECTURE_MODE", "threads")

        return GetServicesResponse(services=services, mode=mode)

    @app.get(
        "/api/services/{module_name}",
        tags=["Gateway"],
        summary="Get service details",
        response_model=ServiceDetailsResponse,
    )
    async def get_service(module_name: str) -> ServiceDetailsResponse:
        """Get detailed information about a specific service."""
        announcement = await registry.get_service(module_name)

        if announcement is None:
            raise HTTPException(
                status_code=404,
                detail=f"Service '{module_name}' not found",
            )

        return ServiceDetailsResponse(
            module=announcement.module,
            version=announcement.version,
            summary=announcement.summary,
            capabilities=announcement.capabilities,
            methods=announcement.methods,
            timestamp=announcement.timestamp,
        )

    @app.get(
        "/api/services/{module_name}/health",
        tags=["Gateway"],
        summary="Check service health",
        response_model=GetServiceHealthResponse,
    )
    async def check_service_health(module_name: str) -> GetServiceHealthResponse:
        """Check health status of a specific service via the bus."""
        from app.shared.services.health import check_service_health

        try:
            health = await check_service_health(module_name)

            return GetServiceHealthResponse(
                module=module_name,
                status=health.get("status", "unknown"),
                checks=health.get("checks", {}),
                timestamp=health.get("timestamp", datetime.utcnow().isoformat()),
                error=health.get("error"),
            )
        except Exception as e:
            return GetServiceHealthResponse(
                module=module_name,
                status="unhealthy",
                checks={},
                timestamp=datetime.utcnow().isoformat(),
                error=str(e),
            )

    @app.get(
        "/api/routes",
        tags=["Gateway"],
        summary="List generated routes",
        response_model=GetRoutesResponse,
    )
    async def list_routes() -> GetRoutesResponse:
        """Get list of all dynamically generated routes."""
        routes_by_service = route_generator.get_routes_by_service()

        return GetRoutesResponse(
            total_routes=route_generator.get_route_count(),
            services=[
                ServiceRoutes(service=svc, routes=routes)
                for svc, routes in routes_by_service.items()
            ],
        )

    # ==========================================================================
    # Error Handlers
    # ==========================================================================

    @app.exception_handler(HTTPException)
    async def http_exception_handler(request: Request, exc: HTTPException):
        """Handle HTTP exceptions with consistent format."""
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "error": exc.detail,
                "status_code": exc.status_code,
                "path": str(request.url.path),
            },
            headers=getattr(exc, "headers", None),
        )

    @app.exception_handler(Exception)
    async def general_exception_handler(request: Request, exc: Exception):
        """Handle unexpected exceptions."""
        log_error(f"Unhandled exception: {exc}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content={
                "error": "Internal server error",
                "status_code": 500,
                "path": str(request.url.path),
            },
        )

    # ==========================================================================
    # Auth Pairing Endpoints
    # ==========================================================================

    @app.post(
        "/api/auth/pairing/start",
        tags=["Auth"],
        summary="Start pairing process",
        response_model=PairingStartResponse,
    )
    async def start_pairing(
        request: Request,
        payload: Annotated[PairingStartRequest, Body(...)],
        auth_service: Annotated[AuthService, Depends(get_auth_service)],
    ) -> PairingStartResponse:
        client_ip = request.client.host if request.client else "unknown"
        code = await auth_service.start_pairing(payload.device_name, client_ip)
        if not code:
            raise HTTPException(status_code=429, detail="Too many pairing attempts")
        return PairingStartResponse(code=code, expires_in_seconds=300)

    @app.get(
        "/api/auth/pairing/connect/{pairing_code}",
        tags=["Auth"],
        summary="Check pairing status",
        response_model=PairingConnectResponse,
    )
    async def connect_pairing(
        pairing_code: str,
        auth_service: Annotated[AuthService, Depends(get_auth_service)],
    ) -> PairingConnectResponse:
        request_data = await auth_service.connect_pairing(pairing_code)
        if not request_data:
            raise HTTPException(status_code=404, detail="Pairing code not found or expired")
        return PairingConnectResponse(
            request_id=request_data["id"],
            device_name=request_data["device_name"],
            status=request_data["status"],
        )

    @app.post(
        "/api/auth/pairing/approve",
        tags=["Auth"],
        summary="Approve pairing request",
        response_model=PairingApproveResponse,
    )
    async def approve_pairing(
        payload: Annotated[PairingApproveRequest, Body(...)],
        token_data: Annotated[Any, Security(check_auth_enabled, scopes=["admin"])],
        auth_service: Annotated[AuthService, Depends(get_auth_service)],
    ) -> PairingApproveResponse:
        user_id = token_data.user_id if hasattr(token_data, "user_id") else "system"
        success = await auth_service.approve_pairing(payload.code, user_id)
        if not success:
            raise HTTPException(status_code=404, detail="Pairing code not found or expired")
        return PairingApproveResponse(success=True)

    @app.post(
        "/api/auth/pairing/exchange",
        tags=["Auth"],
        summary="Exchange pairing code for token",
        response_model=PairingExchangeResponse,
    )
    async def exchange_pairing(
        payload: Annotated[PairingExchangeRequest, Body(...)],
        auth_service: Annotated[AuthService, Depends(get_auth_service)],
    ) -> PairingExchangeResponse:
        result = await auth_service.exchange_pairing(payload.code)
        if not result:
            raise HTTPException(status_code=400, detail="Pairing not approved or expired")
        return PairingExchangeResponse(
            token=result["token"],
            device_id=result["device_id"],
            user_id=result["user_id"],
        )

    @app.get(
        "/api/auth/verify",
        tags=["Auth"],
        summary="Verify token and get user info",
    )
    async def verify_token(
        token_data: Annotated[Any, Security(check_auth_enabled)],
    ) -> dict[str, Any]:
        if token_data == "api_key":
            return {"status": "valid", "type": "api_key"}

        return {
            "status": "valid",
            "type": "token",
            "user_id": token_data.user_id,
            "device_id": token_data.device_id,
            "scopes": token_data.scopes,
        }

    return app
