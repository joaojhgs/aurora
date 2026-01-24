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
        self._mode = os.getenv("AURORA_ARCHITECTURE_MODE", "threads").lower()

    async def on_start(self) -> None:
        """Service-specific startup logic."""
        self._subscribe_to_config_changes()
        await self._start_gateway()

    async def on_stop(self) -> None:
        """Service-specific shutdown logic."""
        await self._stop_gateway()

    async def reload(self, config_section: str | None = None) -> None:
        """Reload service configuration."""
        if config_section is None or config_section == "gateway":
            await self._reload_gateway_config()

    async def _get_gateway_config(self) -> dict[str, Any]:
        """Get gateway configuration from ConfigService.

        Returns:
            Gateway configuration dictionary
        """
        try:
            from app.shared.config.interface import ConfigAPI

            config_api = ConfigAPI()
            gateway_config = await config_api.aget_config(section="gateway")

            if not gateway_config:
                return {
                    "enabled": False,
                    "host": "0.0.0.0",
                    "port": 8000,
                    "request_timeout_s": 30.0,
                    "cors": {"origins": ["*"], "allow_credentials": True},
                    "auth": {"enabled": False, "api_keys": []},
                }

            return gateway_config

        except Exception as e:
            log_warning(f"Failed to get gateway config, using defaults: {e}")
            return {
                "enabled": False,
                "host": "0.0.0.0",
                "port": 8000,
                "request_timeout_s": 30.0,
            }

    async def _start_gateway(self) -> None:
        """Start the FastAPI gateway if enabled."""
        config = await self._get_gateway_config()

        if not config.get("enabled", False):
            log_info("Gateway disabled in configuration")
            return

        try:
            from app.services.gateway.fastapi_app import create_gateway_app
            from app.services.gateway.registry_aggregator import RegistryAggregator

            self._registry_aggregator = RegistryAggregator(
                bus=self.bus,
                mode=self._mode,
            )

            host = config.get("host", "0.0.0.0")
            port = config.get("port", 8000)
            request_timeout = config.get("request_timeout_s", 30.0)
            cors_config = config.get("cors", {})
            cors_origins = cors_config.get("origins", ["*"])
            cors_allow_credentials = cors_config.get("allow_credentials", True)

            auth_config = config.get("auth", {})
            auth_enabled = auth_config.get("enabled", False)
            auth_api_keys = auth_config.get("api_keys", [])

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
        try:
            await self._gateway_server.serve()
        except asyncio.CancelledError:
            log_debug("Gateway server task cancelled")
        except Exception as e:
            log_error(f"Gateway server error: {e}", exc_info=True)

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

    async def _reload_gateway_config(self) -> None:
        """Reload gateway configuration dynamically."""
        try:
            config = await self._get_gateway_config()
            should_be_enabled = config.get("enabled", False)

            if should_be_enabled and not self._gateway_enabled:
                log_info("Gateway enabled via config - starting gateway")
                await self._start_gateway()

            elif not should_be_enabled and self._gateway_enabled:
                log_info("Gateway disabled via config - stopping gateway")
                await self._stop_gateway()

            elif self._gateway_enabled:
                log_info("Gateway config reloaded (host/port changes require restart)")

        except Exception as e:
            log_error(f"Error reloading gateway config: {e}")
