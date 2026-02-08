"""Gateway Service for Aurora.

Provides an HTTP/WebSocket gateway to the Aurora message bus using FastAPI and Uvicorn.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
from typing import Any

from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.shared.services.base_service import BaseService


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
        self._auth_service = None
        self._mode = os.getenv("AURORA_ARCHITECTURE_MODE", "threads").lower()

    async def on_start(self) -> None:
        """Service-specific startup logic."""
        await self._init_auth_service()
        self._subscribe_to_config_changes()
        await self._start_gateway()
        await self._start_webrtc()

    async def on_stop(self) -> None:
        """Service-specific shutdown logic."""
        await self._stop_webrtc()
        await self._stop_gateway()
        # Ensure registry aggregator is stopped if it was created
        if self._registry_aggregator:
            await self._registry_aggregator.stop()
            self._registry_aggregator = None

    async def reload(self, config_section: str | None = None) -> None:
        """Reload service configuration."""
        if config_section is None or config_section == "gateway":
            await self._reload_gateway_config()
            await self._reload_auth_config()

    async def _init_auth_service(self) -> None:
        """Initialize authentication service."""
        try:
            from app.services.gateway.auth_service import AuthService
            from app.services.gateway.dependencies import set_auth_service

            self._auth_service = AuthService()
            await self._auth_service.initialize()
            set_auth_service(self._auth_service)

            # Set initial default device permissions from config
            try:
                settings = await self._get_gateway_config()
                self._auth_service.update_permission_defaults(
                    settings.permissions.default_device_permissions
                )
            except Exception as e:
                log_warning(f"Could not load initial permission defaults: {e}")

            log_info("Gateway Auth Service initialized")
        except Exception as e:
            log_error(f"Failed to initialize Auth Service: {e}")

    async def _get_gateway_config(self) -> Any:
        """Get gateway configuration from ConfigService.

        Returns:
            Gateway configuration object
        """
        try:
            from app.services.gateway.config import Settings
            from app.shared.config.interface import ConfigAPI

            config_api = ConfigAPI()
            all_config = await config_api.aget_config()
            return Settings.model_validate(all_config)

        except Exception as e:
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
            request_timeout = 30.0
            cors_origins = config.cors_origins
            cors_allow_credentials = True

            auth_enabled = config.auth_enabled
            auth_api_keys = config.api_keys

            self._gateway_app = create_gateway_app(
                bus=self.bus,
                registry=self._registry_aggregator,
                cors_origins=cors_origins,
                cors_allow_credentials=cors_allow_credentials,
                auth_enabled=auth_enabled,
                auth_api_keys=auth_api_keys,
                auth_service=self._auth_service,
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
            settings = await self._get_gateway_config()

            if not settings.webrtc.enabled:
                log_info("WebRTC disabled in configuration")
                return

            if not self._registry_aggregator:
                from app.services.gateway.registry_aggregator import RegistryAggregator

                self._registry_aggregator = RegistryAggregator(
                    bus=self.bus,
                    mode=self._mode,
                )

            await self._registry_aggregator.start()

            from app.services.gateway.webrtc.rtc_client import RTCClient

            if not self._auth_service:
                log_error("AuthService not initialized, cannot start WebRTC client")
                return

            from app.services.gateway.dependencies import set_rtc_client

            self._rtc_client = RTCClient(
                settings=settings,
                bus=self.bus,
                registry=self._registry_aggregator,
                auth_service=self._auth_service,
            )
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
                self._gateway_task.cancel()
                with contextlib.suppress(asyncio.CancelledError, TimeoutError):
                    await asyncio.wait_for(self._gateway_task, timeout=5.0)

            if self._registry_aggregator:
                await self._registry_aggregator.stop()

            self._gateway_enabled = False
            log_info("Gateway stopped")

        except Exception as e:
            log_error(f"Error stopping gateway: {e}")

    async def _reload_auth_config(self) -> None:
        """Reload auth/permission settings from config."""
        try:
            settings = await self._get_gateway_config()
            perm_settings = settings.permissions

            if self._rtc_client:
                self._rtc_client._auth_timeout = perm_settings.webrtc_auth_timeout_seconds

            if self._auth_service:
                self._auth_service.update_permission_defaults(
                    perm_settings.default_device_permissions
                )

            log_debug(
                f"Auth config reloaded: webrtc_auth_timeout={perm_settings.webrtc_auth_timeout_seconds}s, "
                f"default_perms={perm_settings.default_device_permissions}"
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
