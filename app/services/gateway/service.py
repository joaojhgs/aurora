"""Gateway Service for Aurora.

Provides an HTTP/WebSocket gateway to the Aurora message bus using FastAPI and Uvicorn.
"""

from __future__ import annotations

import asyncio
import contextlib
import math
import os
import time
from typing import Any

from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.shared.config.keys import ConfigKeys
from app.shared.config.models import (
    Auth as AuthConfigModel,
    Gateway as GatewayConfigModel,
    MeshSharing,
)
from app.shared.contracts.models.auth import AuthMethods
from app.shared.contracts.models.common import EmptyInput
from app.shared.contracts.models.gateway import (
    CapabilityCatalogRequest,
    CapabilityCatalogResponse,
    CapabilityGraph,
    GatewayMethods,
    GetMeshStatusResponse,
    MeshCompatibilityFailure,
    MeshLocalStatus,
    MeshPeerCompatibilityDiagnostic,
    MeshPeerDiagnostic,
    MeshPeerServiceDiagnostic,
    MeshRouteDiagnostic,
    MeshRouteProviderDiagnostic,
    RouteExplainRequest,
    RouteExplainResponse,
)
from app.shared.contracts.registry import method_contract
from app.shared.services.base_service import BaseService


def _config_secret_plain(val: Any) -> Any:
    if val is None:
        return None
    if hasattr(val, "get_secret_value"):
        return val.get_secret_value()
    return val


def _finite_float(value: float | None) -> float | None:
    if value is None:
        return None
    if not math.isfinite(value):
        return None
    return float(value)


def _age_seconds(now: float, timestamp: float | None) -> float | None:
    if not timestamp or timestamp <= 0:
        return None
    return max(now - timestamp, 0.0)


def _peer_service(peer: Any, module: str) -> Any | None:
    manifest = getattr(peer, "manifest", None)
    if not manifest:
        return None
    for svc in manifest.shared_services:
        if svc.module == module:
            return svc
    return None


def _route_reason(
    *,
    module: str,
    config: Any | None,
    decision_target: str,
    providers: list[MeshRouteProviderDiagnostic],
    selected_peer_id: str | None,
    peer_selection: str,
) -> str:
    if config is None:
        return "no mesh routing config; local delivery is used"
    if config.prefer == "local_only":
        return "configured local_only"
    if config.prefer == "local":
        return "configured local preference"
    if decision_target == "remote" and selected_peer_id:
        return f"selected peer {selected_peer_id} using {peer_selection} policy"
    if decision_target == "local":
        if not providers:
            return f"no peer advertises {module}; fallback={config.fallback} selected local"
        rejected = [p.reason for p in providers if not p.eligible]
        detail = "; ".join(sorted(set(rejected))) if rejected else "no eligible remote provider"
        return f"{detail}; fallback={config.fallback} selected local"
    if decision_target == "error":
        return "no eligible remote provider and fallback=error"
    if decision_target == "none":
        return "no eligible remote provider and local fallback is disabled"
    return f"route target is {decision_target}"


class GatewayService(BaseService):
    """Gateway Service for Aurora.

    Provides an HTTP API for external access to Aurora services.
    """

    def __init__(self):
        """Initialize the gateway service."""
        super().__init__(
            module="Gateway",
            summary="HTTP API Gateway for Aurora services",
            capabilities=["http_api", "service_discovery", "websocket"],
        )
        self._gateway_enabled = False
        self._gateway_app = None
        self._gateway_server = None
        self._gateway_task = None
        self._registry_aggregator = None
        self._rtc_client = None
        self._mode = os.getenv("AURORA_ARCHITECTURE_MODE", "threads").lower()

        # Mesh P2P components
        self._mesh_peer_registry = None
        self._mesh_routing_table = None
        self._mesh_peer_bridge = None
        self._mesh_latency_monitor = None
        self._mesh_announcer = None
        self._mesh_bus = None
        self._mesh_peer_id = None
        self._runtime_config_lock = asyncio.Lock()

    async def on_start(self) -> None:
        """Service-specific startup logic."""
        await self._start_gateway()
        await self._start_webrtc()
        await self._start_mesh()

    async def on_stop(self) -> None:
        """Service-specific shutdown logic."""
        await self._stop_mesh()
        await self._stop_webrtc()
        await self._stop_gateway()
        # Ensure registry aggregator is stopped if it was created
        if self._registry_aggregator:
            await self._registry_aggregator.stop()
            self._registry_aggregator = None

    async def reload(self, config_section: str | None = None) -> None:
        """Reload service configuration."""
        if config_section in (None, "services", "gateway", "auth"):
            async with self._runtime_config_lock:
                await self._reload_gateway_config()
                await self._reload_auth_config()
                await self._reload_mesh_config()

    async def reload_config(self, event) -> None:
        """Reload Gateway only for Gateway/Auth config changes."""
        key_path = getattr(event, "key_path", "") or ""
        affected_sections = getattr(event, "affected_sections", []) or []
        relevant = (
            key_path.startswith("services.gateway")
            or key_path.startswith("services.auth")
            or any(
                str(section).startswith(("services.gateway", "services.auth"))
                for section in affected_sections
            )
        )
        if not relevant:
            log_debug(f"Ignoring unrelated config change for Gateway: {key_path}")
            return
        async with self._runtime_config_lock:
            await self._reload_gateway_config()
            await self._reload_auth_config()
            await self._reload_mesh_config()

    @method_contract(
        method_id=GatewayMethods.GET_MESH_STATUS,
        summary="Get read-only mesh status and routing diagnostics",
        input_model=EmptyInput,
        output_model=GetMeshStatusResponse,
        exposure="external",
        method_type="manage",
        required_perms=["Gateway.manage"],
    )
    async def get_mesh_status(self, data: EmptyInput) -> GetMeshStatusResponse:
        """Return a redacted diagnostic snapshot of mesh state and routing."""
        settings = await self._get_gateway_config()
        mesh_config = settings.mesh
        registry = self._mesh_peer_registry
        routing_table = self._mesh_routing_table

        shared_modules = sorted(
            module for module, service in mesh_config.services.items() if service.share
        )
        routed_modules = sorted(
            module
            for module, service in mesh_config.services.items()
            if service.prefer not in ("local", "local_only")
        )

        peers = registry.get_all_peers() if registry else []
        local = MeshLocalStatus(
            mesh_enabled=mesh_config.enabled,
            mesh_started=self._mesh_bus is not None,
            webrtc_started=self._rtc_client is not None,
            peer_id=self._mesh_peer_id,
            node_name=mesh_config.node_name,
            peer_selection=mesh_config.peer_selection,
            version_policy=mesh_config.version_policy,
            shared_modules=shared_modules,
            routed_modules=routed_modules,
        )

        peer_diagnostics = [
            self._build_peer_diagnostic(peer, mesh_config)
            for peer in sorted(peers, key=lambda p: p.peer_id)
        ]

        route_modules = set(mesh_config.services.keys())
        for peer in peers:
            if peer.manifest:
                route_modules.update(svc.module for svc in peer.manifest.shared_services)

        route_diagnostics = [
            self._build_route_diagnostic(module, mesh_config, registry, routing_table)
            for module in sorted(route_modules)
        ]

        compatibility_failures: list[MeshCompatibilityFailure] = []
        for peer in peer_diagnostics:
            for module in peer.compatibility.local_incompatible:
                compatibility_failures.append(
                    MeshCompatibilityFailure(
                        peer_id=peer.peer_id,
                        module=module,
                        direction="local_view_of_remote",
                        reason="remote service failed local version/capability requirements",
                    )
                )
            for module in peer.compatibility.remote_incompatible:
                compatibility_failures.append(
                    MeshCompatibilityFailure(
                        peer_id=peer.peer_id,
                        module=module,
                        direction="remote_view_of_local",
                        reason="local service failed remote version/capability requirements",
                    )
                )

        return GetMeshStatusResponse(
            local=local,
            peers=peer_diagnostics,
            routes=route_diagnostics,
            compatibility_failures=compatibility_failures,
            secrets_redacted=True,
        )

    @method_contract(
        method_id=GatewayMethods.GET_CAPABILITY_GRAPH,
        summary="Get a redacted mesh capability graph",
        input_model=EmptyInput,
        output_model=CapabilityGraph,
        exposure="external",
        method_type="manage",
        required_perms=["Gateway.manage"],
    )
    async def get_capability_graph(self, data: EmptyInput) -> CapabilityGraph:
        """Return a first-class capability graph without credential-bearing fields."""
        from app.services.gateway.mesh.capability_graph import build_capability_graph

        settings = await self._get_gateway_config()
        local_services = {}
        if self._registry_aggregator:
            local_services = self._registry_aggregator.snapshot_services()

        peers = self._mesh_peer_registry.get_all_peers() if self._mesh_peer_registry else []
        return build_capability_graph(
            mesh_config=settings.mesh,
            local_services=local_services,
            peers=peers,
            local_peer_id=self._mesh_peer_id,
        )

    @method_contract(
        method_id=GatewayMethods.GET_CAPABILITY_CATALOG,
        summary="Get canonical executable capability catalog",
        input_model=CapabilityCatalogRequest,
        output_model=CapabilityCatalogResponse,
        exposure="external",
        method_type="manage",
        required_perms=["Gateway.manage"],
    )
    async def get_capability_catalog(
        self,
        data: CapabilityCatalogRequest,
    ) -> CapabilityCatalogResponse:
        """Return a product-facing local + remote capability catalog."""
        from app.services.gateway.mesh.capability_catalog import build_capability_catalog

        settings = await self._get_gateway_config()
        local_services = {}
        if self._registry_aggregator:
            local_services = self._registry_aggregator.snapshot_services()

        peers = self._mesh_peer_registry.get_all_peers() if self._mesh_peer_registry else []
        return build_capability_catalog(
            request=data,
            mesh_config=settings.mesh,
            local_services=local_services,
            peers=peers,
            local_peer_id=self._mesh_peer_id,
        )

    @method_contract(
        method_id=GatewayMethods.EXPLAIN_ROUTE,
        summary="Explain mesh route selection and provider eligibility",
        input_model=RouteExplainRequest,
        output_model=RouteExplainResponse,
        exposure="external",
        method_type="manage",
        required_perms=["Gateway.manage"],
    )
    async def explain_route(self, data: RouteExplainRequest) -> RouteExplainResponse:
        """Return selected target, candidates, and route blockers for a selector."""
        from app.services.gateway.mesh.capability_catalog import explain_route

        settings = await self._get_gateway_config()
        local_services = {}
        if self._registry_aggregator:
            local_services = self._registry_aggregator.snapshot_services()

        return explain_route(
            request=data,
            mesh_config=settings.mesh,
            local_services=local_services,
            registry=self._mesh_peer_registry,
            routing_table=self._mesh_routing_table,
            local_peer_id=self._mesh_peer_id,
        )

    def _build_peer_diagnostic(self, peer: Any, mesh_config: Any) -> MeshPeerDiagnostic:
        """Serialize peer state without credential-bearing fields."""
        from app.services.gateway.mesh.negotiation import generate_manifest_ack

        now = time.monotonic()
        manifest = peer.manifest
        local_ack = generate_manifest_ack(manifest, mesh_config) if manifest else None

        services: list[MeshPeerServiceDiagnostic] = []
        if manifest:
            for svc in manifest.shared_services:
                available_capacity = None
                if svc.max_concurrent > 0:
                    available_capacity = max(svc.max_concurrent - peer.active_calls, 0)
                services.append(
                    MeshPeerServiceDiagnostic(
                        module=svc.module,
                        version=svc.version,
                        capabilities=list(svc.capabilities),
                        method_names=sorted(m.name for m in svc.methods),
                        max_concurrent=svc.max_concurrent,
                        active_calls=peer.active_calls,
                        available_capacity=available_capacity,
                        digest=svc.digest,
                    )
                )

        return MeshPeerDiagnostic(
            peer_id=peer.peer_id,
            node_name=peer.node_name,
            status=peer.status,
            latency_ms=_finite_float(peer.latency_ms),
            last_ping_age_s=_age_seconds(now, peer.last_ping),
            last_manifest_age_s=_age_seconds(now, peer.last_manifest),
            active_calls=peer.active_calls,
            services=services,
            compatibility=MeshPeerCompatibilityDiagnostic(
                local_compatible=list(local_ack.compatible_services) if local_ack else [],
                local_incompatible=list(local_ack.incompatible_services) if local_ack else [],
                local_unused=list(local_ack.unused_services) if local_ack else [],
                remote_compatible=list(peer.remote_compatible),
                remote_incompatible=list(peer.remote_incompatible),
                remote_unused=list(peer.remote_unused),
            ),
        )

    def _build_route_diagnostic(
        self,
        module: str,
        mesh_config: Any,
        registry: Any,
        routing_table: Any,
    ) -> MeshRouteDiagnostic:
        """Explain the current route decision and peer eligibility for a module."""
        config = mesh_config.services.get(module)
        route = None
        if routing_table:
            route = routing_table.resolve(f"{module}.Diagnostic")

        providers: list[MeshRouteProviderDiagnostic] = []
        if registry:
            candidates = registry.get_provider_candidates(
                module=module,
                routing_config=config,
                version_policy=mesh_config.version_policy,
                include_ineligible=True,
            )
            for candidate in sorted(candidates, key=lambda c: c.peer.peer_id):
                providers.append(
                    MeshRouteProviderDiagnostic(
                        peer_id=candidate.peer.peer_id,
                        node_name=candidate.peer.node_name,
                        status=candidate.peer.status,
                        version=candidate.service.version,
                        latency_ms=_finite_float(candidate.peer.latency_ms),
                        active_calls=candidate.peer.active_calls,
                        max_concurrent=candidate.service.max_concurrent,
                        eligible=candidate.eligible,
                        reason_code=candidate.reason_code,
                        reason=candidate.reason,
                    )
                )

        decision_target = route.target if route else "local"
        reason = _route_reason(
            module=module,
            config=config,
            decision_target=decision_target,
            providers=providers,
            selected_peer_id=route.peer_id if route else None,
            peer_selection=mesh_config.peer_selection,
        )

        return MeshRouteDiagnostic(
            module=module,
            configured=config is not None,
            share=bool(config.share) if config else False,
            prefer=config.prefer if config else "",
            fallback=config.fallback if config else "",
            min_version=config.min_version if config else None,
            required_capabilities=list(config.required_capabilities) if config else [],
            decision_target=decision_target,
            decision_peer_id=route.peer_id if route else None,
            decision_version=route.version if route else "",
            decision_latency_ms=_finite_float(route.latency_ms) if route else None,
            reason=reason,
            providers=providers,
        )

    async def _get_gateway_config(self) -> Any:
        """Get gateway configuration from ConfigService.

        Returns:
            Gateway configuration object
        """
        try:
            from app.services.gateway.config import (
                APISettings,
                MeshConfig,
                MeshServiceConfig,
                MQTTSettings,
                PermissionSettings,
                Settings,
                WebRTCSettings,
            )
            from app.shared.config.interface import ConfigAPI

            config_api = ConfigAPI()

            gw_conf = await config_api.aget(
                ConfigKeys.services.gateway,
                GatewayConfigModel,
                config_timeout=20.0,
            )
            auth_conf = await config_api.aget(
                ConfigKeys.services.auth,
                AuthConfigModel,
                config_timeout=20.0,
            )

            gw_d = gw_conf.model_dump(mode="python")
            auth_d = auth_conf.model_dump(mode="python")

            api_d = dict(gw_d.get("api") or {})
            if "token_secret" in api_d:
                api_d["token_secret"] = _config_secret_plain(api_d.get("token_secret"))

            gateway_for_api = {k: v for k, v in gw_d.items() if k != "api"}
            gateway_for_api.update(api_d)
            gateway_for_api["auth"] = dict(auth_d)
            raw_keys = gateway_for_api["auth"].get("api_keys")
            if raw_keys:
                gateway_for_api["auth"]["api_keys"] = [_config_secret_plain(x) for x in raw_keys]

            mesh = dict(gw_d.get("mesh_network") or {})

            async def _mesh_service_config(mesh_key: str) -> MeshServiceConfig:
                ms = await config_api.aget(mesh_key, MeshSharing, config_timeout=20.0)
                return MeshServiceConfig.model_validate(ms.model_dump())

            mesh["services"] = {
                "STTCoordinator": await _mesh_service_config(
                    ConfigKeys.services.stt.coordinator.mesh_sharing
                ),
                "WakeWord": await _mesh_service_config(
                    ConfigKeys.services.stt.wakeword.mesh_sharing
                ),
                "Transcription": await _mesh_service_config(
                    ConfigKeys.services.stt.transcription.mesh_sharing
                ),
                "DB": await _mesh_service_config(ConfigKeys.services.db.mesh_sharing),
                "TTS": await _mesh_service_config(ConfigKeys.services.tts.mesh_sharing),
                "Tooling": await _mesh_service_config(ConfigKeys.services.tooling.mesh_sharing),
                "Scheduler": await _mesh_service_config(ConfigKeys.services.scheduler.mesh_sharing),
                "Orchestrator": await _mesh_service_config(
                    ConfigKeys.services.orchestrator.mesh_sharing
                ),
            }

            webrtc_d = dict(gw_d.get("webrtc") or {})
            if webrtc_d:
                webrtc_d["password"] = _config_secret_plain(webrtc_d.get("password")) or ""

            mqtt_d = dict(gw_d.get("signaling_mqtt") or {})

            return Settings(
                api=APISettings.from_gateway_dict(gateway_for_api),
                webrtc=WebRTCSettings.model_validate(webrtc_d) if webrtc_d else WebRTCSettings(),
                signaling_mqtt=MQTTSettings.model_validate(mqtt_d) if mqtt_d else MQTTSettings(),
                permissions=PermissionSettings.model_validate(auth_d)
                if auth_d
                else PermissionSettings(),
                mesh=MeshConfig.model_validate(mesh) if mesh else MeshConfig(),
            )

        except Exception as e:
            from app.helpers.aurora_logger import log_warning

            log_warning(f"Failed to get gateway config, using defaults: {e}")
            from app.services.gateway.config import Settings

            return Settings()

    async def _start_gateway(self) -> None:
        """Start the FastAPI gateway if enabled."""
        settings = await self._get_gateway_config()
        config = settings.api

        if not config.enabled:
            log_info("Gateway disabled in configuration")
            return

        # Persist token_secret to .env when auth is enabled and it was auto-generated
        # (required for JWT signing and mesh inbound token encryption at rest)
        if config.auth_enabled:
            try:
                from dotenv import set_key

                from app.shared.config.interface import ConfigAPI

                cfg_api = ConfigAPI()
                has_env = bool(os.environ.get("AURORA_TOKEN_SECRET"))
                existing_secret = await cfg_api.aget(
                    ConfigKeys.services.gateway.api.token_secret,
                    default="",
                    config_timeout=20.0,
                )
                plain_secret = _config_secret_plain(existing_secret)
                has_config = bool(str(plain_secret).strip()) if plain_secret is not None else False
                if not has_env and not has_config:
                    env_path = ".env"
                    if not os.path.exists(env_path):
                        open(env_path, "a").close()
                    set_key(env_path, "AURORA_TOKEN_SECRET", config.token_secret)
                    os.environ["AURORA_TOKEN_SECRET"] = config.token_secret
                    persisted = await cfg_api.aupdate_config(
                        ConfigKeys.services.gateway.api.token_secret,
                        config.token_secret,
                        timeout=20.0,
                    )
                    if not persisted:
                        log_warning(
                            "token_secret written to .env but Config.Set failed — "
                            "other services may not see services.gateway.api.token_secret until config is updated"
                        )
                    log_info(
                        "Auto-generated token_secret (JWT / mesh crypto): .env + ConfigService."
                    )
            except Exception as e:
                log_warning(f"Could not persist token_secret to .env: {e}")

        try:
            from app.services.gateway.fastapi_app import create_gateway_app
            from app.services.gateway.registry_aggregator import RegistryAggregator

            if not self._registry_aggregator:
                self._registry_aggregator = RegistryAggregator(
                    bus=self.bus,
                    mode=self._mode,
                )

            host = config.host
            port = config.port
            request_timeout = config.request_timeout
            cors_origins = config.cors_origins
            cors_allow_credentials = config.cors_allow_credentials

            auth_enabled = config.auth_enabled
            auth_api_keys = config.api_keys

            self._gateway_app = create_gateway_app(
                bus=self.bus,
                registry=self._registry_aggregator,
                cors_origins=cors_origins,
                cors_allow_credentials=cors_allow_credentials,
                auth_enabled=auth_enabled,
                auth_api_keys=auth_api_keys,
                request_timeout=request_timeout,
            )

            import uvicorn

            uvicorn_config = uvicorn.Config(
                self._gateway_app,
                host=host,
                port=port,
                log_level="info",
                access_log=True,
            )
            self._gateway_server = uvicorn.Server(uvicorn_config)
            self._gateway_task = asyncio.create_task(self._run_gateway_server())

            self._gateway_enabled = True
            log_info(f"Gateway started at http://{host}:{port}")
            log_info(f"  API docs: http://{host}:{port}/api/docs")

        except ImportError as e:
            log_warning(
                f"Gateway dependencies not installed. Install with: pip install 'aurora[gateway]'. Error: {e}"
            )
        except Exception as e:
            log_error(f"Failed to start gateway: {e}", exc_info=True)

    async def _run_gateway_server(self) -> None:
        """Run the uvicorn server (background task)."""
        server = self._gateway_server
        if not server:
            return
        try:
            await server.serve()
        except asyncio.CancelledError:
            log_debug("Gateway server task cancelled")
        except Exception as e:
            log_error(f"Gateway server error: {e}", exc_info=True)

    async def _start_webrtc(self) -> None:
        """Start the WebRTC client if enabled."""
        try:
            if self._rtc_client:
                log_debug("WebRTC client already initialized - skipping duplicate start")
                return

            settings = await self._get_gateway_config()

            if not settings.webrtc.enabled:
                log_info("WebRTC disabled in configuration")
                return

            # Enhancement A: Auto-generate room ID and password if at defaults
            config_changed = False
            try:
                import secrets as _secrets

                from app.shared.config.interface import ConfigAPI

                cfg_api = ConfigAPI()

                if settings.webrtc.room in ("default", ""):
                    new_room = f"aurora-{_secrets.token_hex(8)}"
                    ok = await cfg_api.aupdate_config(
                        ConfigKeys.services.gateway.webrtc.room, new_room
                    )
                    if not ok:
                        log_warning(
                            "Could not persist WebRTC room via Config.Set; using in-memory value only"
                        )
                    settings.webrtc.room = new_room
                    config_changed = True
                    log_info(f"Auto-generated WebRTC room ID: {new_room}")

                if not settings.webrtc.password:
                    new_password = _secrets.token_urlsafe(32)
                    ok = await cfg_api.aupdate_config(
                        ConfigKeys.services.gateway.webrtc.password, new_password
                    )
                    if not ok:
                        log_warning(
                            "Could not persist WebRTC password via Config.Set; using in-memory value only"
                        )
                    settings.webrtc.password = new_password
                    config_changed = True
                    log_info("Auto-generated WebRTC room password")

                if config_changed:
                    log_info(
                        "Room credentials auto-generated and persisted via ConfigService. "
                        "Use 'python scripts/config_updater.py --room-export' to share with other devices."
                    )
            except Exception as e:
                log_warning(f"Could not auto-generate room credentials: {e}")

            if not self._registry_aggregator:
                from app.services.gateway.registry_aggregator import RegistryAggregator

                self._registry_aggregator = RegistryAggregator(
                    bus=self.bus,
                    mode=self._mode,
                )

            await self._registry_aggregator.start()

            from app.services.gateway.auth_proxy import BusAuthProxy
            from app.services.gateway.dependencies import set_rtc_client
            from app.services.gateway.webrtc.rtc_client import RTCClient

            auth_proxy = BusAuthProxy(self.bus)

            self._rtc_client = RTCClient(
                settings=settings,
                bus=self.bus,
                registry=self._registry_aggregator,
                auth_service=auth_proxy,
                require_auth=settings.api.auth_enabled,
            )
            # Enhancement B: Wire pairing timeout from config
            self._rtc_client._pairing_timeout = settings.permissions.webrtc_pairing_timeout_seconds
            await self._rtc_client.start()
            set_rtc_client(self._rtc_client)
            log_info("WebRTC client started")

        except ImportError as e:
            log_warning(f"WebRTC dependencies not installed: {e}")
        except Exception as e:
            log_error(f"Failed to start WebRTC client: {e}", exc_info=True)

    async def _stop_webrtc(self) -> None:
        """Stop the WebRTC client."""
        if self._rtc_client:
            from app.services.gateway.dependencies import set_rtc_client

            log_info("Stopping WebRTC client...")
            await self._rtc_client.close()
            self._rtc_client = None
            set_rtc_client(None)
            log_info("WebRTC client stopped")

    async def _stop_gateway(self) -> None:
        """Stop the FastAPI gateway."""
        if not self._gateway_enabled:
            return

        log_info("Stopping gateway...")

        try:
            if self._gateway_server:
                self._gateway_server.should_exit = True

            if self._gateway_task and not self._gateway_task.done():
                try:
                    await asyncio.wait_for(asyncio.shield(self._gateway_task), timeout=5.0)
                except TimeoutError:
                    self._gateway_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await self._gateway_task

            if self._registry_aggregator:
                await self._registry_aggregator.stop()

            self._gateway_enabled = False
            log_info("Gateway stopped")

        except Exception as e:
            log_error(f"Error stopping gateway: {e}")

    async def _reload_auth_config(self) -> None:
        """Reload WebRTC auth/permission settings from config."""
        try:
            settings = await self._get_gateway_config()
            perm_settings = settings.permissions

            if self._rtc_client:
                self._rtc_client._auth_timeout = perm_settings.webrtc_auth_timeout_seconds
                self._rtc_client._pairing_timeout = perm_settings.webrtc_pairing_timeout_seconds
                self._rtc_client._require_auth = settings.api.auth_enabled

            from app.services.gateway.auth_proxy import BusAuthProxy
            from app.services.gateway.dependencies import get_gateway_auth

            gateway_auth = get_gateway_auth()
            gateway_auth._auth_service = BusAuthProxy(self.bus)
            gateway_auth._api_keys = set(settings.api.api_keys or [])
            gateway_auth.set_enabled(settings.api.auth_enabled)

            log_debug(
                f"WebRTC auth config reloaded: webrtc_auth_timeout={perm_settings.webrtc_auth_timeout_seconds}s, "
                f"pairing_timeout={perm_settings.webrtc_pairing_timeout_seconds}s, "
                f"auth_enabled={settings.api.auth_enabled}"
            )
        except Exception as e:
            log_error(f"Error reloading auth config: {e}")

    async def _reload_gateway_config(self) -> None:
        """Reload gateway configuration dynamically."""
        try:
            settings = await self._get_gateway_config()

            if settings.api.enabled and not self._gateway_enabled:
                log_info("Gateway enabled via config - starting gateway")
                await self._start_gateway()
            elif not settings.api.enabled and self._gateway_enabled:
                log_info("Gateway disabled via config - stopping gateway")
                await self._stop_gateway()

            if settings.webrtc.enabled and not self._rtc_client:
                log_info("WebRTC enabled via config - starting WebRTC client")
                await self._start_webrtc()
            elif not settings.webrtc.enabled and self._rtc_client:
                log_info("WebRTC disabled via config - stopping WebRTC client")
                await self._stop_webrtc()

            log_info("Gateway config reloaded")

        except Exception as e:
            log_error(f"Error reloading gateway config: {e}")

    # ── Mesh P2P lifecycle ───────────────────────────────────────────────

    async def _start_mesh(self) -> None:
        """Initialize and start mesh P2P components if enabled.

        Creates PeerRegistry, RoutingTable, PeerBridge, LatencyMonitor,
        and MeshBus. Configures the RTCClient for mesh and replaces
        the global bus singleton.
        """
        try:
            if self._mesh_bus:
                log_debug("Mesh P2P already initialized — skipping duplicate start")
                return

            settings = await self._get_gateway_config()
            mesh_config = settings.mesh

            if not mesh_config.enabled:
                log_debug("Mesh P2P disabled in configuration")
                return

            if not self._rtc_client:
                log_warning("Mesh P2P requires WebRTC — skipping mesh init")
                return

            from app.messaging.bus_runtime import get_bus, set_bus
            from app.messaging.mesh_bus import MeshBus
            from app.services.gateway.mesh.announcer import MeshAnnouncer
            from app.services.gateway.mesh.latency import LatencyMonitor
            from app.services.gateway.mesh.peer_bridge import PeerBridge
            from app.services.gateway.mesh.peer_registry import PeerRegistry
            from app.services.gateway.mesh.routing_table import RoutingTable

            # ── Fix 1: Stable peer_id from DB ────────────────────────────
            peer_id = await self._get_or_create_peer_id(mesh_config)
            self._mesh_peer_id = peer_id

            # Create mesh components
            self._mesh_peer_registry = PeerRegistry(mesh_config)
            self._mesh_routing_table = RoutingTable(mesh_config, self._mesh_peer_registry)
            self._mesh_peer_bridge = PeerBridge(self._rtc_client, self._mesh_peer_registry)

            self._mesh_latency_monitor = LatencyMonitor(
                self._rtc_client,
                self._mesh_peer_registry,
                interval_s=mesh_config.ping_interval_s,
            )
            self._mesh_peer_bridge.set_latency_monitor(self._mesh_latency_monitor)

            # ── Fix 2: Wire DB persistence callbacks on PeerRegistry ─────
            room_name_for_callbacks = settings.webrtc.room or "default"
            bus_for_callbacks = self.bus

            async def _on_peer_registered(p_id: str, p_name: str, p_status: str) -> None:
                from app.shared.contracts.models.mesh import MeshPeerUpsertRequest

                await bus_for_callbacks.request(
                    AuthMethods.MESH_UPSERT_PEER,
                    MeshPeerUpsertRequest(
                        peer_id=p_id,
                        room_name=room_name_for_callbacks,
                        node_name=p_name,
                    ),
                    timeout=5.0,
                )

            async def _on_peer_removed(p_id: str, p_name: str, p_status: str) -> None:
                from app.shared.contracts.models.mesh import (
                    MeshPeerUpdateConnectionRequest,
                )

                await bus_for_callbacks.request(
                    AuthMethods.MESH_UPDATE_PEER_CONNECTION,
                    MeshPeerUpdateConnectionRequest(
                        peer_id=p_id,
                        room_name=room_name_for_callbacks,
                        connection_status="disconnected",
                    ),
                    timeout=5.0,
                )

            async def _on_peer_status_changed(p_id: str, p_name: str, p_status: str) -> None:
                from app.shared.contracts.models.mesh import (
                    MeshPeerUpdateConnectionRequest,
                )

                await bus_for_callbacks.request(
                    AuthMethods.MESH_UPDATE_PEER_CONNECTION,
                    MeshPeerUpdateConnectionRequest(
                        peer_id=p_id,
                        room_name=room_name_for_callbacks,
                        connection_status=p_status,
                    ),
                    timeout=5.0,
                )

            self._mesh_peer_registry.on_peer_registered = _on_peer_registered
            self._mesh_peer_registry.on_peer_removed = _on_peer_removed
            self._mesh_peer_registry.on_peer_status_changed = _on_peer_status_changed

            # Configure RTCClient for mesh
            self._rtc_client.set_mesh_identity(
                peer_id=peer_id,
                node_name=mesh_config.node_name or "",
            )
            self._rtc_client.configure_mesh(
                mesh_config=mesh_config,
                peer_registry=self._mesh_peer_registry,
                peer_bridge=self._mesh_peer_bridge,
            )

            # ── Fix 3: Load per-peer inbound credentials ─────────────────
            room_name = settings.webrtc.room or "default"
            try:
                from app.shared.contracts.models.mesh import MeshPeerLoadInboundRequest

                resp = await self.bus.request(
                    AuthMethods.MESH_LOAD_INBOUND_CREDENTIALS,
                    MeshPeerLoadInboundRequest(room_name=room_name),
                    timeout=5.0,
                )
                creds = resp.data.get("credentials", {}) if hasattr(resp, "data") else {}
                if isinstance(resp, dict):
                    creds = resp.get("credentials", {})
                elif hasattr(resp, "credentials"):
                    creds = resp.credentials

                if creds:
                    # Pass per-peer tokens to RTCClient
                    self._rtc_client.set_saved_peer_tokens(creds)
                    log_info(f"Loaded {len(creds)} inbound credential(s) for room '{room_name}'")
                else:
                    log_debug(f"No inbound credentials for room '{room_name}'")
                    from app.shared.contracts.models.auth import MeshCredentialLoadRequest

                    legacy_resp = await self.bus.request(
                        AuthMethods.LOAD_MESH_CREDENTIAL,
                        MeshCredentialLoadRequest(room_name=room_name),
                        timeout=5.0,
                    )
                    legacy_data = legacy_resp.data if hasattr(legacy_resp, "data") else legacy_resp
                    legacy_token = (
                        legacy_data.get("token")
                        if isinstance(legacy_data, dict)
                        else getattr(legacy_data, "token", None)
                    )
                    if legacy_token:
                        self._rtc_client.set_saved_auth_token(legacy_token)
                        log_info(f"Loaded legacy mesh credential for room '{room_name}'")
            except Exception as e:
                log_warning(f"Could not load mesh credentials: {e}")
            await self._rtc_client.refresh_presence()

            # ── Fix 3: Per-peer persist callback ─────────────────────────
            bus_ref = self.bus  # capture for closure

            async def _persist_token(
                token_str: str,
                remote_device_id: str | None = None,
                remote_user_id: str | None = None,
                remote_peer_id: str | None = None,
                remote_node_name: str | None = None,
                permissions: list[str] | None = None,
            ) -> None:
                """Persist an inbound token from a remote peer."""
                try:
                    if remote_peer_id:
                        # New per-peer save
                        from app.shared.contracts.models.mesh import (
                            MeshPeerSaveInboundRequest,
                            MeshPeerUpsertRequest,
                        )

                        # Ensure peer row exists
                        await bus_ref.request(
                            AuthMethods.MESH_UPSERT_PEER,
                            MeshPeerUpsertRequest(
                                peer_id=remote_peer_id,
                                room_name=room_name,
                                node_name=remote_node_name or "",
                            ),
                            timeout=5.0,
                        )
                        # Save inbound credential
                        await bus_ref.request(
                            AuthMethods.MESH_SAVE_INBOUND_CREDENTIAL,
                            MeshPeerSaveInboundRequest(
                                remote_peer_id=remote_peer_id,
                                room_name=room_name,
                                token=token_str,
                                permissions=permissions or [],
                                remote_device_id=remote_device_id,
                                remote_user_id=remote_user_id,
                                remote_node_name=remote_node_name,
                            ),
                            timeout=5.0,
                        )
                    else:
                        # Legacy single-room save (backward compat)
                        from app.shared.contracts.models.auth import MeshCredentialSaveRequest

                        await bus_ref.request(
                            AuthMethods.SAVE_MESH_CREDENTIAL,
                            MeshCredentialSaveRequest(
                                room_name=room_name,
                                token=token_str,
                                remote_device_id=remote_device_id,
                                remote_user_id=remote_user_id,
                            ),
                            timeout=5.0,
                        )
                except Exception as exc:
                    log_warning(f"Failed to persist mesh pairing token: {exc}")

            self._rtc_client.set_on_token_saved(_persist_token)

            # Create MeshBus wrapping the current service bus. In process mode the
            # legacy bus_runtime singleton is not initialized, but BaseService.bus
            # already points at this service's active BullMQ bus.
            inner_bus = self.bus
            self._mesh_bus = MeshBus(
                inner_bus=inner_bus,
                routing_table=self._mesh_routing_table,
                peer_bridge=self._mesh_peer_bridge,
                mesh_config=mesh_config,
            )

            # Replace the global bus singleton with MeshBus
            # Update BOTH singletons so all code paths see the MeshBus
            set_bus(self._mesh_bus)
            from app.shared.messaging.bus_init import set_bus as set_shared_bus

            set_shared_bus(self._mesh_bus)

            # Start background tasks
            await self._mesh_peer_registry.start()
            await self._mesh_latency_monitor.start()

            # Start periodic manifest re-announcer
            self._mesh_announcer = MeshAnnouncer(
                self._rtc_client,
                interval_s=mesh_config.registry_announce_interval_s,
            )
            await self._mesh_announcer.start()

            node_name = mesh_config.node_name or "unnamed"
            shared = [m for m, s in mesh_config.services.items() if s.share]
            routed = [m for m, s in mesh_config.services.items() if s.prefer != "local"]
            log_info(
                f"Mesh P2P started — node='{node_name}', peer_id='{peer_id}', "
                f"sharing={shared}, routed={routed}"
            )

        except ImportError as e:
            log_warning(f"Mesh dependencies not available: {e}")
        except Exception as e:
            log_error(f"Failed to start mesh P2P: {e}", exc_info=True)

    async def _get_or_create_peer_id(self, mesh_config: Any) -> str:
        """Load a stable peer_id from the DB, or generate and persist one.

        This ensures the same Aurora instance always announces the same
        ``peer_id`` across restarts, which is critical for bilateral peer
        approval and token mapping.

        Args:
            mesh_config: The current mesh configuration object.

        Returns:
            The stable peer_id string.
        """
        import secrets as _secrets

        try:
            from app.shared.contracts.models.mesh import (
                MeshIdentityLoadRequest,
                MeshIdentitySaveRequest,
            )

            resp = await self.bus.request(
                AuthMethods.LOAD_MESH_IDENTITY,
                MeshIdentityLoadRequest(),
                timeout=5.0,
            )
            data = resp.data if hasattr(resp, "data") else resp
            if isinstance(data, dict):
                saved_peer_id = data.get("peer_id")
            else:
                saved_peer_id = getattr(data, "peer_id", None)

            node_name = getattr(mesh_config, "node_name", "") or ""

            if saved_peer_id:
                log_info(f"Loaded stable mesh peer_id from DB: {saved_peer_id}")
                # Update node_name if changed
                await self.bus.request(
                    AuthMethods.SAVE_MESH_IDENTITY,
                    MeshIdentitySaveRequest(peer_id=saved_peer_id, node_name=node_name),
                    timeout=5.0,
                )
                return saved_peer_id

            # Generate new peer_id
            new_peer_id = f"aurora-{_secrets.token_hex(16)}"
            await self.bus.request(
                AuthMethods.SAVE_MESH_IDENTITY,
                MeshIdentitySaveRequest(peer_id=new_peer_id, node_name=node_name),
                timeout=5.0,
            )
            log_info(f"Generated and saved new mesh peer_id: {new_peer_id}")
            return new_peer_id

        except Exception as e:
            log_warning(f"Could not load/save mesh identity, using ephemeral: {e}")
            return f"aurora-{_secrets.token_hex(16)}"

    async def _stop_mesh(self) -> None:
        """Stop mesh P2P components and restore original bus."""
        if not self._mesh_bus:
            return

        try:
            log_info("Stopping mesh P2P...")

            # Restore the inner bus as the global singleton (both modules)
            from app.messaging.bus_runtime import set_bus
            from app.shared.messaging.bus_init import set_bus as set_shared_bus

            if self._mesh_bus:
                inner = self._mesh_bus._inner
                set_bus(inner)
                set_shared_bus(inner)
                self._mesh_bus = None
                self._mesh_peer_id = None

            # Stop background tasks
            if self._mesh_announcer:
                await self._mesh_announcer.stop()
                self._mesh_announcer = None

            if self._mesh_latency_monitor:
                await self._mesh_latency_monitor.stop()
                self._mesh_latency_monitor = None

            if self._mesh_peer_registry:
                await self._mesh_peer_registry.stop()
                self._mesh_peer_registry = None

            # Cancel pending bridge calls
            if self._mesh_peer_bridge:
                await self._mesh_peer_bridge.cancel_all()
                self._mesh_peer_bridge = None

            self._mesh_routing_table = None

            log_info("Mesh P2P stopped")

        except Exception as e:
            log_error(f"Error stopping mesh P2P: {e}")

    async def _reload_mesh_config(self) -> None:
        """Reload mesh configuration dynamically."""
        try:
            settings = await self._get_gateway_config()
            mesh_config = settings.mesh

            if mesh_config.enabled and not self._mesh_bus:
                log_info("Mesh enabled via config — starting mesh P2P")
                await self._start_mesh()
            elif not mesh_config.enabled and self._mesh_bus:
                log_info("Mesh disabled via config — stopping mesh P2P")
                await self._stop_mesh()
            elif mesh_config.enabled and self._mesh_bus:
                # Update config on existing components
                if self._mesh_peer_registry:
                    self._mesh_peer_registry._config = mesh_config
                if self._mesh_routing_table:
                    self._mesh_routing_table._config = mesh_config
                if self._mesh_bus:
                    self._mesh_bus._config = mesh_config
                log_info("Mesh config reloaded")

        except Exception as e:
            log_error(f"Error reloading mesh config: {e}")
