"""FastAPI Application Factory for Aurora Gateway.

Creates and configures the FastAPI application with:
- Dynamic service routes from contract registry
- Standard endpoints (health, registry, services)
- CORS middleware
- Error handling

Auth, admin, and pairing endpoints are auto-generated from the Auth service
contracts via RouteGenerator.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime
from typing import TYPE_CHECKING, Annotated, Any

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Security
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from app.helpers.aurora_logger import log_error, log_info
from app.services.gateway.auth import check_auth_enabled, create_scoped_auth_check
from app.services.gateway.dependencies import get_rtc_client
from app.shared.contracts.models.aurora import AuroraEventStreamEvent, AuroraMethods
from app.shared.contracts.models.gateway import GatewayListEventsRequest, GatewayMethods
from app.shared.contracts.models.orchestrator import OrchestratorMethods

if TYPE_CHECKING:
    from app.messaging.bus import MessageBus
    from app.services.gateway.admin_action import AdminActionManager
    from app.services.gateway.registry_aggregator import RegistryAggregator


def create_gateway_app(
    bus: MessageBus,
    registry: RegistryAggregator,
    cors_origins: list[str] | None = None,
    cors_allow_credentials: bool = True,
    auth_enabled: bool = False,
    auth_api_keys: list[str] | None = None,
    title: str = "Aurora Gateway API",
    version: str = "1.0.0",
    request_timeout: float = 30.0,
    admin_action_manager: AdminActionManager | None = None,
) -> Any:
    """Create and configure the FastAPI application.

    Auth, admin, and pairing endpoints are auto-generated from the Auth
    service method contracts by RouteGenerator. Only infrastructure
    endpoints (health, registry, services, peers) are defined here.

    Args:
        bus: Message bus instance
        registry: Registry aggregator instance
        cors_origins: List of allowed CORS origins (default: ["*"])
        cors_allow_credentials: Whether to allow credentials in CORS
        auth_enabled: Whether to enable authentication
        auth_api_keys: List of valid API keys
        title: API title for OpenAPI docs
        version: API version
        request_timeout: Default timeout for service requests
        admin_action_manager: Short-lived AdminAction draft/confirmation store

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
        description=(
            "Aurora Voice Assistant HTTP Gateway API.\n\n"
            "This API provides HTTP access to Aurora services via the message bus.\n"
            "Routes are dynamically generated from the contract registry.\n\n"
            "## Authentication\n\n"
            "Protected endpoints accept **either** of the following:\n\n"
            "| Method | Header | Example |\n"
            "|--------|--------|---------|\n"
            "| API Key | `X-API-Key: <key>` | `X-API-Key: my-secret-key` |\n"
            "| Bearer Token | `Authorization: Bearer <token>` "
            "| `Authorization: Bearer eyJ…` |\n\n"
            'Use the **Authorize** button above to set credentials for "Try it out".\n\n'
            "Canonical public auth routes are `POST /api/Auth/Login`, "
            "`POST /api/Auth/PairingStart`, `POST /api/Auth/PairingConnect`, "
            "and `POST /api/Auth/PairingExchange`. When auth is enabled, these "
            "routes run as an anonymous caller, not as the system principal."
        ),
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

    # Always install auth middleware so runtime config can enable/disable it.
    from app.services.gateway.auth import GatewayAuth, create_auth_middleware
    from app.services.gateway.auth_proxy import BusAuthProxy
    from app.services.gateway.dependencies import set_gateway_auth

    gateway_auth = GatewayAuth(
        auth_service=BusAuthProxy(bus),
        enabled=auth_enabled,
        api_keys=auth_api_keys or [],
    )
    set_gateway_auth(gateway_auth)
    auth_middleware = create_auth_middleware(gateway_auth)
    app.middleware("http")(auth_middleware)
    log_info(f"Gateway authentication {'enabled' if auth_enabled else 'disabled'}")

    # Create route generator
    route_generator = RouteGenerator(
        bus=bus,
        registry=registry,
        request_timeout=request_timeout,
        admin_action_manager=admin_action_manager,
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

    stream_events_auth = Security(create_scoped_auth_check(method_type="use"), scopes=[])

    @app.get(
        "/api/events/stream",
        tags=["Gateway"],
        summary="Stream unified Aurora events",
        response_class=StreamingResponse,
        responses={
            200: {
                "description": "Server-sent event stream of Aurora.EventStream envelopes",
                "content": {"text/event-stream": {"schema": {"type": "string"}}},
            }
        },
    )
    async def stream_events(
        topic: Annotated[list[str] | None, Query()] = None,
        kind: Annotated[list[str] | None, Query()] = None,
        last_event_id: str | None = None,
        replay_from: str | None = None,
        backfill: bool = False,
        correlation_id: str | None = None,
        _auth: Any = stream_events_auth,
    ) -> StreamingResponse:
        """Stream normalized event envelopes as Server-Sent Events."""
        topics = topic or []
        categories, kinds = _event_stream_filters(kind or [])
        _authorize_event_stream_request(
            _auth,
            topics=topics,
            categories=categories,
            kinds=kinds,
            correlation_id=correlation_id,
        )
        queue: asyncio.Queue[AuroraEventStreamEvent] = asyncio.Queue(maxsize=100)

        async def on_event(envelope: Any) -> None:
            payload = envelope.payload
            if not isinstance(payload, AuroraEventStreamEvent):
                payload = AuroraEventStreamEvent.model_validate(payload)
            if not _event_matches_stream_request(
                payload,
                topics=topics,
                categories=categories,
                kinds=kinds,
                correlation_id=correlation_id,
            ):
                return
            try:
                queue.put_nowait(payload)
            except asyncio.QueueFull:
                await queue.get()
                queue.task_done()
                queue.put_nowait(payload)

        async def event_generator():
            bus.subscribe(AuroraMethods.EVENT_STREAM, on_event)
            try:
                if backfill or last_event_id or replay_from:
                    async for event in _stream_backfill_events(
                        bus,
                        topics=topics,
                        categories=categories,
                        kinds=kinds,
                        correlation_id=correlation_id,
                        last_event_id=last_event_id,
                        replay_from=replay_from,
                    ):
                        yield _sse_payload(event)
                while True:
                    event = await queue.get()
                    yield _sse_payload(event)
                    queue.task_done()
            finally:
                bus.unsubscribe(AuroraMethods.EVENT_STREAM, on_event)

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Aurora-Event-Topic": AuroraMethods.EVENT_STREAM,
            },
        )

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
    # WebRTC Peer Management (Gateway-specific, not Auth)
    # ==========================================================================

    @app.get(
        "/api/admin/peers",
        tags=["Admin"],
        summary="List connected WebRTC peers",
    )
    async def list_peers(
        _identity: Annotated[Any, Security(check_auth_enabled, scopes=["Auth.manage"])],
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
        _identity: Annotated[Any, Security(check_auth_enabled, scopes=["Auth.manage"])],
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
        _identity: Annotated[Any, Security(check_auth_enabled, scopes=["Auth.manage"])],
    ) -> dict[str, bool]:
        rtc = get_rtc_client()
        if not rtc:
            raise HTTPException(status_code=404, detail="WebRTC not enabled")
        success = await rtc.update_peer_permissions(peer_id)
        if not success:
            raise HTTPException(status_code=404, detail="Peer not found or not authenticated")
        return {"success": True}

    return app


_SAFE_ASSISTANT_KINDS = {
    "assistant",
    "assistant.delta",
    "assistant.completed",
    "assistant.failed",
    "tool.requested",
    "tool.completed",
}


def _event_stream_filters(kind: list[str]) -> tuple[set[str], set[str]]:
    categories: set[str] = set()
    kinds: set[str] = set()
    for item in kind:
        normalized = item.strip()
        if not normalized:
            continue
        if "." in normalized:
            kinds.add(normalized)
        else:
            categories.add(normalized)
    return categories, kinds


def _authorize_event_stream_request(
    identity: Any,
    *,
    topics: list[str],
    categories: set[str],
    kinds: set[str],
    correlation_id: str | None,
) -> None:
    if identity.can("Gateway.manage", method_type="manage"):
        return
    topic_set = set(topics)
    assistant_scoped = (
        correlation_id is not None
        and (not topic_set or topic_set == {OrchestratorMethods.RESPONSE})
        and (not categories or categories <= {"assistant"})
        and (not kinds or kinds <= _SAFE_ASSISTANT_KINDS)
    )
    if assistant_scoped and identity.can("Orchestrator.use", method_type="use"):
        return
    raise HTTPException(
        status_code=403,
        detail=(
            "Gateway.manage is required for broad event streams; "
            "Orchestrator.use may only subscribe to correlated assistant events"
        ),
    )


def _event_matches_stream_request(
    event: AuroraEventStreamEvent,
    *,
    topics: list[str],
    categories: set[str],
    kinds: set[str],
    correlation_id: str | None,
) -> bool:
    if topics and event.topic not in set(topics):
        return False
    if categories and event.category not in categories:
        return False
    if kinds and event.kind not in kinds and event.category not in kinds:
        return False
    return not (correlation_id and event.correlation_id != correlation_id)


async def _stream_backfill_events(
    bus: Any,
    *,
    topics: list[str],
    categories: set[str],
    kinds: set[str],
    correlation_id: str | None,
    last_event_id: str | None,
    replay_from: str | None,
):
    request = GatewayListEventsRequest(
        topics=topics or None,
        categories=list(categories) or None,
        kinds=list(kinds) or None,
        correlation_id=correlation_id,
        last_event_id=last_event_id,
        replay_from=replay_from,
        limit=500,
    )
    try:
        result = await bus.request(
            GatewayMethods.LIST_EVENTS,
            request,
            timeout=2.0,
            origin="internal",
        )
    except Exception as exc:
        yield _degraded_event(f"bounded backfill unavailable: {exc}")
        return
    if not getattr(result, "ok", False):
        yield _degraded_event(str(getattr(result, "error", None) or "bounded backfill unavailable"))
        return
    events = list(getattr(result.data, "events", []) or [])
    for event in reversed(events):
        yield event
    if (last_event_id or replay_from) and not events:
        yield _degraded_event(
            "requested replay cursor is not present in the bounded Gateway event buffer"
        )


def _degraded_event(message: str) -> AuroraEventStreamEvent:
    return AuroraEventStreamEvent(
        event_id="stream-degraded",
        topic=AuroraMethods.EVENT_STREAM,
        kind="stream.degraded",
        category="unknown",
        action="backfill",
        status="degraded",
        severity="warning",
        redacted_payload={
            "code": "bounded_replay_unavailable",
            "message": message,
            "durable_replay": False,
        },
    )


def _sse_payload(event: AuroraEventStreamEvent) -> str:
    payload = event.model_dump(mode="json")
    data = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    event_name = event.kind or event.category
    return f"id: {event.event_id}\nevent: {event_name}\ndata: {data}\n\n"
