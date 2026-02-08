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
from app.services.gateway.acl.audit import audit_event
from app.services.gateway.auth import check_auth_enabled
from app.services.gateway.auth_service import AuthService
from app.services.gateway.dependencies import get_auth_service, get_rtc_client
from app.services.gateway.schemas.auth import (
    DeviceResponse,
    IdentityResponse,
    LoginRequest,
    LoginResponse,
    PairingApproveRequest,
    PairingApproveResponse,
    PairingConnectResponse,
    PairingExchangeRequest,
    PairingExchangeResponse,
    PairingStartRequest,
    PairingStartResponse,
    PasswordChangeRequest,
    PermissionPatchRequest,
    PermissionSetRequest,
    PrincipalCreateRequest,
    PrincipalResponse,
    PrincipalUpdateRequest,
    TokenCreateRequest,
    TokenCreateResponse,
    TokenRefreshResponse,
    TokenResponse,
    TokenScopeUpdateRequest,
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
    # Auth Endpoints — Login / Logout / Me / Token Refresh
    # ==========================================================================

    @app.post(
        "/api/auth/login",
        tags=["Auth"],
        summary="Authenticate and receive a session token",
        response_model=LoginResponse,
    )
    async def login(
        request: Request,
        payload: Annotated[LoginRequest, Body(...)],
        auth_service: Annotated[AuthService, Depends(get_auth_service)],
    ) -> LoginResponse:
        client_ip = request.client.host if request.client else "unknown"

        # IP-based rate limiting (similar to pairing)
        if auth_service.login_attempts.get(client_ip, 0) >= 10:
            await audit_event(
                auth_service.db_manager,
                "login.rate_limited",
                details={"ip": client_ip, "username": payload.username},
                ip_address=client_ip,
            )
            raise HTTPException(status_code=429, detail="Too many login attempts")

        result = await auth_service.login(payload.username, payload.password)

        if not result:
            auth_service.login_attempts[client_ip] = (
                auth_service.login_attempts.get(client_ip, 0) + 1
            )
            await audit_event(
                auth_service.db_manager,
                "login.failure",
                details={"username": payload.username, "ip": client_ip},
                ip_address=client_ip,
            )
            raise HTTPException(status_code=401, detail="Invalid username or password")

        token, token_str, user = result
        # Reset rate limit on success
        auth_service.login_attempts.pop(client_ip, None)

        await audit_event(
            auth_service.db_manager,
            "login.success",
            principal_id=user.id,
            details={"username": user.username, "ip": client_ip},
            ip_address=client_ip,
        )
        return LoginResponse(
            token=token_str,
            user_id=user.id,
            username=user.username,
            permissions=user.permissions or [],
            is_admin=user.is_admin,
            expires_at=token.expires_at.isoformat() if token.expires_at else None,
        )

    @app.post(
        "/api/auth/logout",
        tags=["Auth"],
        summary="Revoke the current session token",
        status_code=204,
    )
    async def logout(
        request: Request,
        identity: Annotated[Any, Security(check_auth_enabled)],
        auth_service: Annotated[AuthService, Depends(get_auth_service)],
    ) -> None:
        # Extract the token from the Authorization header and revoke it
        auth_header = request.headers.get("Authorization")
        if auth_header and auth_header.startswith("Bearer "):
            token_str = auth_header.split(" ", 1)[1]
            token = await auth_service.authenticate_token(token_str)
            if token:
                await auth_service.db_manager.revoke_token(token.id)
                await audit_event(
                    auth_service.db_manager,
                    "token.revoked",
                    principal_id=identity.principal_id,
                    details={"token_id": token.id, "reason": "logout"},
                )

    @app.get(
        "/api/auth/me",
        tags=["Auth"],
        summary="Get current identity with full permissions",
        response_model=IdentityResponse,
    )
    async def get_me(
        identity: Annotated[Any, Security(check_auth_enabled)],
    ) -> IdentityResponse:
        return IdentityResponse(
            principal_id=identity.principal_id,
            principal_name=identity.principal_name,
            device_id=identity.device_id,
            is_admin=identity.is_admin,
            permissions=list(identity.permissions),
            effective_perms=list(identity.effective_perms),
            source=identity.source,
        )

    @app.post(
        "/api/auth/token/refresh",
        tags=["Auth"],
        summary="Refresh the current token (revoke old, issue new)",
        response_model=TokenRefreshResponse,
    )
    async def refresh_token(
        request: Request,
        identity: Annotated[Any, Security(check_auth_enabled)],
        auth_service: Annotated[AuthService, Depends(get_auth_service)],
    ) -> TokenRefreshResponse:
        auth_header = request.headers.get("Authorization")
        if not auth_header or not auth_header.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Bearer token required")

        token_str = auth_header.split(" ", 1)[1]
        result = await auth_service.refresh_token(token_str)
        if not result:
            raise HTTPException(status_code=400, detail="Token refresh failed")

        new_token, new_token_str = result
        return TokenRefreshResponse(
            token=new_token_str,
            expires_at=new_token.expires_at.isoformat() if new_token.expires_at else None,
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
        await audit_event(
            auth_service.db_manager,
            "pairing.started",
            details={"device_name": payload.device_name, "ip": client_ip},
            ip_address=client_ip,
        )
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
        identity: Annotated[Any, Security(check_auth_enabled, scopes=["auth.approve"])],
        auth_service: Annotated[AuthService, Depends(get_auth_service)],
    ) -> PairingApproveResponse:
        user_id = identity.principal_id if hasattr(identity, "principal_id") else "system"
        success = await auth_service.approve_pairing(
            payload.code,
            user_id,
            permissions=payload.permissions,
            is_admin=payload.is_admin,
        )
        if not success:
            raise HTTPException(status_code=404, detail="Pairing code not found or expired")
        await audit_event(
            auth_service.db_manager,
            "pairing.approved",
            principal_id=user_id,
            details={"code": payload.code, "permissions": payload.permissions, "is_admin": payload.is_admin},
        )
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
        await audit_event(
            auth_service.db_manager,
            "pairing.exchanged",
            principal_id=result["user_id"],
            details={"device_id": result["device_id"], "user_id": result["user_id"]},
        )
        return PairingExchangeResponse(
            token=result["token"],
            device_id=result["device_id"],
            user_id=result["user_id"],
            permissions=result.get("permissions", []),
        )

    @app.get(
        "/api/auth/verify",
        tags=["Auth"],
        summary="Verify token and get user info",
    )
    async def verify_token(
        identity: Annotated[Any, Security(check_auth_enabled)],
    ) -> dict[str, Any]:
        return {
            "status": "valid",
            "principal_id": identity.principal_id,
            "principal_name": identity.principal_name,
            "is_admin": identity.is_admin,
            "permissions": list(identity.permissions),
            "effective_perms": list(identity.effective_perms),
            "device_id": identity.device_id,
            "source": identity.source,
        }

    # ── Principal Management ────────────────────────────────────────────

    @app.get(
        "/api/admin/principals",
        tags=["Admin"],
        summary="List all principals",
        response_model=list[PrincipalResponse],
    )
    async def list_principals(
        identity: Annotated[Any, Security(check_auth_enabled, scopes=["auth.manage"])],
        auth_service: Annotated[AuthService, Depends(get_auth_service)],
    ) -> list[PrincipalResponse]:
        users = await auth_service.list_principals()
        return [
            PrincipalResponse(
                id=u.id,
                username=u.username,
                permissions=u.permissions or [],
                is_admin=u.is_admin,
                created_at=u.created_at.isoformat() if u.created_at else None,
            )
            for u in users
        ]

    @app.post(
        "/api/admin/principals",
        tags=["Admin"],
        summary="Create a new principal",
        response_model=PrincipalResponse,
        status_code=201,
    )
    async def create_principal(
        payload: Annotated[PrincipalCreateRequest, Body(...)],
        identity: Annotated[Any, Security(check_auth_enabled, scopes=["auth.manage"])],
        auth_service: Annotated[AuthService, Depends(get_auth_service)],
    ) -> PrincipalResponse:
        user = await auth_service.create_principal(
            username=payload.username,
            password=payload.password,
            permissions=payload.permissions,
            is_admin=payload.is_admin,
        )
        if not user:
            raise HTTPException(status_code=400, detail="Failed to create principal")
        await audit_event(
            auth_service.db_manager,
            "principal.created",
            principal_id=identity.principal_id,
            details={"created_user": user.id, "username": user.username},
        )
        return PrincipalResponse(
            id=user.id,
            username=user.username,
            permissions=user.permissions or [],
            is_admin=user.is_admin,
            created_at=user.created_at.isoformat() if user.created_at else None,
        )

    @app.get(
        "/api/admin/principals/{principal_id}",
        tags=["Admin"],
        summary="Get a principal by ID",
        response_model=PrincipalResponse,
    )
    async def get_principal(
        principal_id: str,
        identity: Annotated[Any, Security(check_auth_enabled, scopes=["auth.manage"])],
        auth_service: Annotated[AuthService, Depends(get_auth_service)],
    ) -> PrincipalResponse:
        user = await auth_service.get_principal(principal_id)
        if not user:
            raise HTTPException(status_code=404, detail="Principal not found")
        return PrincipalResponse(
            id=user.id,
            username=user.username,
            permissions=user.permissions or [],
            is_admin=user.is_admin,
            created_at=user.created_at.isoformat() if user.created_at else None,
        )

    @app.patch(
        "/api/admin/principals/{principal_id}",
        tags=["Admin"],
        summary="Update a principal",
        response_model=PrincipalResponse,
    )
    async def update_principal(
        principal_id: str,
        payload: Annotated[PrincipalUpdateRequest, Body(...)],
        identity: Annotated[Any, Security(check_auth_enabled, scopes=["auth.manage"])],
        auth_service: Annotated[AuthService, Depends(get_auth_service)],
    ) -> PrincipalResponse:
        fields = {k: v for k, v in payload.model_dump().items() if v is not None}
        user = await auth_service.update_principal(principal_id, **fields)
        if not user:
            raise HTTPException(status_code=404, detail="Principal not found")
        return PrincipalResponse(
            id=user.id,
            username=user.username,
            permissions=user.permissions or [],
            is_admin=user.is_admin,
            created_at=user.created_at.isoformat() if user.created_at else None,
        )

    @app.delete(
        "/api/admin/principals/{principal_id}",
        tags=["Admin"],
        summary="Delete a principal",
        status_code=204,
    )
    async def delete_principal(
        principal_id: str,
        identity: Annotated[Any, Security(check_auth_enabled, scopes=["auth.manage"])],
        auth_service: Annotated[AuthService, Depends(get_auth_service)],
    ) -> None:
        success = await auth_service.delete_principal(principal_id)
        if not success:
            raise HTTPException(status_code=404, detail="Principal not found")
        await audit_event(
            auth_service.db_manager,
            "principal.deleted",
            principal_id=identity.principal_id,
            details={"deleted_user": principal_id},
        )

    # ── Permission Management ────────────────────────────────────────────

    @app.put(
        "/api/admin/principals/{principal_id}/permissions",
        tags=["Admin"],
        summary="Set permissions for a principal (full replace)",
        response_model=PrincipalResponse,
    )
    async def set_permissions(
        principal_id: str,
        payload: Annotated[PermissionSetRequest, Body(...)],
        identity: Annotated[Any, Security(check_auth_enabled, scopes=["auth.manage"])],
        auth_service: Annotated[AuthService, Depends(get_auth_service)],
    ) -> PrincipalResponse:
        success = await auth_service.set_permissions(principal_id, payload.permissions)
        if not success:
            raise HTTPException(status_code=404, detail="Principal not found")
        await audit_event(
            auth_service.db_manager,
            "permission.set",
            principal_id=identity.principal_id,
            details={"target_user": principal_id, "permissions": payload.permissions},
        )
        user = await auth_service.get_principal(principal_id)
        if not user:
            raise HTTPException(status_code=404, detail="Principal not found")
        return PrincipalResponse(
            id=user.id,
            username=user.username,
            permissions=user.permissions or [],
            is_admin=user.is_admin,
            created_at=user.created_at.isoformat() if user.created_at else None,
        )

    @app.patch(
        "/api/admin/principals/{principal_id}/permissions",
        tags=["Admin"],
        summary="Grant or revoke specific permissions",
        response_model=PrincipalResponse,
    )
    async def patch_permissions(
        principal_id: str,
        payload: Annotated[PermissionPatchRequest, Body(...)],
        identity: Annotated[Any, Security(check_auth_enabled, scopes=["auth.manage"])],
        auth_service: Annotated[AuthService, Depends(get_auth_service)],
    ) -> PrincipalResponse:
        success = await auth_service.patch_permissions(
            principal_id, grant=payload.grant, revoke=payload.revoke
        )
        if not success:
            raise HTTPException(status_code=404, detail="Principal not found")
        await audit_event(
            auth_service.db_manager,
            "permission.patched",
            principal_id=identity.principal_id,
            details={"target_user": principal_id, "grant": payload.grant, "revoke": payload.revoke},
        )
        user = await auth_service.get_principal(principal_id)
        if not user:
            raise HTTPException(status_code=404, detail="Principal not found")
        return PrincipalResponse(
            id=user.id,
            username=user.username,
            permissions=user.permissions or [],
            is_admin=user.is_admin,
            created_at=user.created_at.isoformat() if user.created_at else None,
        )

    # ── Password Management ──────────────────────────────────────────────

    @app.post(
        "/api/auth/change-password",
        tags=["Auth"],
        summary="Change the current user's password",
    )
    async def change_password(
        payload: Annotated[PasswordChangeRequest, Body(...)],
        identity: Annotated[Any, Security(check_auth_enabled)],
        auth_service: Annotated[AuthService, Depends(get_auth_service)],
    ) -> dict[str, bool]:
        success = await auth_service.change_password(
            identity.principal_id, payload.old_password, payload.new_password
        )
        if not success:
            raise HTTPException(status_code=400, detail="Password change failed")
        await audit_event(
            auth_service.db_manager,
            "password.changed",
            principal_id=identity.principal_id,
        )
        return {"success": True}

    # ── Token Management ─────────────────────────────────────────────────

    @app.get(
        "/api/admin/tokens",
        tags=["Admin"],
        summary="List tokens",
        response_model=list[TokenResponse],
    )
    async def list_tokens(
        identity: Annotated[Any, Security(check_auth_enabled, scopes=["auth.manage"])],
        auth_service: Annotated[AuthService, Depends(get_auth_service)],
        principal_id: str | None = None,
        device_id: str | None = None,
    ) -> list[TokenResponse]:
        tokens = await auth_service.list_tokens(principal_id=principal_id, device_id=device_id)
        return [
            TokenResponse(
                id=t.id,
                prefix=t.prefix,
                device_id=t.device_id,
                user_id=t.user_id,
                scopes=t.scopes or [],
                created_at=t.created_at.isoformat() if t.created_at else None,
                expires_at=t.expires_at.isoformat() if t.expires_at else None,
            )
            for t in tokens
        ]

    @app.post(
        "/api/admin/tokens",
        tags=["Admin"],
        summary="Create a token for a principal",
        response_model=TokenCreateResponse,
        status_code=201,
    )
    async def create_token(
        payload: Annotated[TokenCreateRequest, Body(...)],
        identity: Annotated[Any, Security(check_auth_enabled, scopes=["auth.manage"])],
        auth_service: Annotated[AuthService, Depends(get_auth_service)],
    ) -> TokenCreateResponse:
        try:
            result = await auth_service.create_token_for_principal(
                principal_id=payload.principal_id,
                device_id=payload.device_id,
                scopes=payload.scopes,
                expires_in_days=payload.expires_in_days,
            )
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        if not result:
            raise HTTPException(status_code=400, detail="Failed to create token")
        token, token_str = result
        await audit_event(
            auth_service.db_manager,
            "token.created",
            principal_id=identity.principal_id,
            details={
                "token_id": token.id,
                "for_principal": payload.principal_id,
                "scopes": token.scopes or [],
            },
        )
        return TokenCreateResponse(
            token=token_str,
            id=token.id,
            prefix=token.prefix,
            scopes=token.scopes or [],
            expires_at=token.expires_at.isoformat() if token.expires_at else None,
        )

    @app.patch(
        "/api/admin/tokens/{token_id}/scopes",
        tags=["Admin"],
        summary="Update token scopes",
    )
    async def update_token_scopes(
        token_id: str,
        payload: Annotated[TokenScopeUpdateRequest, Body(...)],
        identity: Annotated[Any, Security(check_auth_enabled, scopes=["auth.manage"])],
        auth_service: Annotated[AuthService, Depends(get_auth_service)],
    ) -> dict[str, bool]:
        try:
            success = await auth_service.update_token_scopes(token_id, payload.scopes)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        if not success:
            raise HTTPException(status_code=404, detail="Token not found")
        await audit_event(
            auth_service.db_manager,
            "token.scopes_updated",
            principal_id=identity.principal_id,
            details={"token_id": token_id, "new_scopes": payload.scopes},
        )
        return {"success": True}

    @app.delete(
        "/api/admin/tokens/{token_id}",
        tags=["Admin"],
        summary="Revoke a token",
        status_code=204,
    )
    async def revoke_token(
        token_id: str,
        identity: Annotated[Any, Security(check_auth_enabled, scopes=["auth.manage"])],
        auth_service: Annotated[AuthService, Depends(get_auth_service)],
    ) -> None:
        success = await auth_service.db_manager.revoke_token(token_id)
        if not success:
            raise HTTPException(status_code=404, detail="Token not found")
        await audit_event(
            auth_service.db_manager,
            "token.revoked",
            principal_id=identity.principal_id,
            details={"token_id": token_id},
        )

    # ── Device Management ────────────────────────────────────────────────

    @app.get(
        "/api/admin/devices",
        tags=["Admin"],
        summary="List all devices",
        response_model=list[DeviceResponse],
    )
    async def list_devices(
        identity: Annotated[Any, Security(check_auth_enabled, scopes=["auth.manage"])],
        auth_service: Annotated[AuthService, Depends(get_auth_service)],
    ) -> list[DeviceResponse]:
        devices = await auth_service.db_manager.list_devices()
        return [
            DeviceResponse(
                id=d.id,
                user_id=d.user_id,
                name=d.name,
                is_trusted=d.is_trusted,
                created_at=d.created_at.isoformat() if d.created_at else None,
                last_seen=d.last_seen.isoformat() if d.last_seen else None,
            )
            for d in devices
        ]

    @app.delete(
        "/api/admin/devices/{device_id}",
        tags=["Admin"],
        summary="Delete a device (cascades to tokens)",
        status_code=204,
    )
    async def delete_device(
        device_id: str,
        identity: Annotated[Any, Security(check_auth_enabled, scopes=["auth.manage"])],
        auth_service: Annotated[AuthService, Depends(get_auth_service)],
    ) -> None:
        success = await auth_service.db_manager.delete_device(device_id)
        if not success:
            raise HTTPException(status_code=404, detail="Device not found")

    # ── Audit Log ─────────────────────────────────────────────────────

    @app.get(
        "/api/admin/audit",
        tags=["Admin"],
        summary="Query the audit log",
    )
    async def query_audit_log(
        identity: Annotated[Any, Security(check_auth_enabled, scopes=["auth.audit"])],
        auth_service: Annotated[AuthService, Depends(get_auth_service)],
        event: str | None = None,
        principal_id: str | None = None,
        since: str | None = None,
        until: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        return await auth_service.db_manager.get_audit_log(
            event=event,
            principal_id=principal_id,
            since=since,
            until=until,
            limit=limit,
            offset=offset,
        )

    # ── WebRTC Peer Management ─────────────────────────────────────────

    @app.get(
        "/api/admin/peers",
        tags=["Admin"],
        summary="List connected WebRTC peers",
    )
    async def list_peers(
        identity: Annotated[Any, Security(check_auth_enabled, scopes=["auth.manage"])],
    ) -> list[dict[str, Any]]:
        rtc = get_rtc_client()
        if not rtc:
            return []
        return rtc.get_connected_peers()

    @app.delete(
        "/api/admin/peers/{peer_id}",
        tags=["Admin"],
        summary="Disconnect a WebRTC peer",
        status_code=204,
    )
    async def disconnect_peer(
        peer_id: str,
        identity: Annotated[Any, Security(check_auth_enabled, scopes=["auth.manage"])],
    ) -> None:
        rtc = get_rtc_client()
        if not rtc:
            raise HTTPException(status_code=404, detail="WebRTC not enabled")
        success = await rtc.disconnect_peer(peer_id)
        if not success:
            raise HTTPException(status_code=404, detail="Peer not found")

    @app.post(
        "/api/admin/peers/{peer_id}/refresh-permissions",
        tags=["Admin"],
        summary="Refresh the permissions of a connected peer from DB",
    )
    async def refresh_peer_permissions(
        peer_id: str,
        identity: Annotated[Any, Security(check_auth_enabled, scopes=["auth.manage"])],
    ) -> dict[str, bool]:
        rtc = get_rtc_client()
        if not rtc:
            raise HTTPException(status_code=404, detail="WebRTC not enabled")
        success = await rtc.update_peer_permissions(peer_id)
        if not success:
            raise HTTPException(status_code=404, detail="Peer not found or not authenticated")
        return {"success": True}

    return app
