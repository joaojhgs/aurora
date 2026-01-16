"""Supervisor for managing Aurora services in parallel architecture.

The supervisor:
- Initializes the message bus (LocalBus or BullMQBus)
- Starts all services (thread mode) or connects to them (process mode)
- Optionally runs HTTP Gateway for external API access
- Manages service lifecycle
- Handles graceful shutdown
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import signal
from typing import TYPE_CHECKING, Any

from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.messaging import Envelope
from app.messaging.bus import MessageBus
from app.messaging.bus_runtime import set_bus
from app.messaging.local_bus import LocalBus
from app.shared.contracts.models.common import EmptyInput
from app.shared.contracts.models.supervisor import (
    GetStatusResponse,
    ServiceControlCommand,
    ServiceControlResponse,
    ServiceStatus,
    SupervisorMethods,
    SupervisorModule,
)
from app.shared.contracts.registry import method_contract
from app.shared.services.base_service import BaseService

if TYPE_CHECKING:
    from app.services.gateway.registry_aggregator import RegistryAggregator


class Supervisor(BaseService):
    """Supervisor for managing Aurora services.

    Responsibilities:
    - Initialize message bus based on configuration
    - Start all services in the correct order
    - Handle graceful shutdown
    - Manage service health and restarts
    """

    def __init__(self):
        """Initialize the supervisor."""
        super().__init__(
            module=SupervisorModule.NAME,
            summary="Service supervisor and manager",
            capabilities=["service_management", "health_monitoring", "gateway"],
        )
        self.services: list[Any] = []
        self.shutdown_event = asyncio.Event()
        self._mode = "threads"  # "threads" or "processes"
        self.process_launcher = None  # ProcessLauncher instance for processes mode

        # Gateway components
        self._gateway_enabled = False
        self._gateway_app = None
        self._gateway_server = None
        self._gateway_task = None
        self._registry_aggregator: RegistryAggregator | None = None

    async def initialize(self) -> None:
        """Initialize the supervisor and message bus."""
        log_info("Initializing Aurora Supervisor...")

        log_info("Initializing Aurora Supervisor...")

        # Get architecture mode from environment variable (default: threads)
        import os

        self._mode = os.getenv("AURORA_ARCHITECTURE_MODE", "threads").lower()

        log_info(f"Architecture mode: {self._mode}")

        # Initialize message bus based on mode
        if self._mode == "threads":
            await self._initialize_local_bus()
        elif self._mode == "processes":
            await self._initialize_bullmq_bus()
        else:
            raise ValueError(f"Unknown architecture mode: {self._mode}")

        # Set global bus instance (for threads mode singleton)
        set_bus(self._bus)

        # Also set in shared bus_init for consistency
        from app.shared.messaging.bus_init import set_bus as set_shared_bus

        set_shared_bus(self._bus)

        # Also set in bus_runtime for ConfigAPI compatibility
        from app.messaging.bus_runtime import set_bus as set_runtime_bus

        set_runtime_bus(self._bus)

        log_info("Supervisor initialized")

    async def _initialize_local_bus(self) -> None:
        """Initialize LocalBus for thread mode."""
        log_info("Initializing LocalBus (thread mode)...")

        self._bus = LocalBus(
            command_queue_size=1000,
            event_queue_size=5000,
        )

        await self._bus.start()
        log_info("LocalBus initialized")

    async def _initialize_bullmq_bus(self) -> None:
        """Initialize BullMQBus for process mode."""
        log_info("Initializing BullMQBus (process mode)...")

        # Get Redis URL from environment variable
        import os

        from app.messaging.bullmq_bus import BullMQBus

        redis_url = os.getenv("REDIS_URL", "redis://localhost:6379")

        self._bus = BullMQBus(redis_url=redis_url)
        await self._bus.start()
        log_info("BullMQBus initialized")

    async def start_services(self) -> None:
        """Start all Aurora services in parallel."""
        log_info("Starting Aurora services...")

        if self._mode == "processes":
            await self._start_services_processes()
        else:
            await self._start_services_threads()

        # Start gateway after all services are up
        await self._start_gateway()

    async def _start_services_threads(self) -> None:
        """Start all services in threads mode (same process)."""
        log_info("Starting services in threads mode...")

        # Import services
        from app.services.db import DBService
        from app.services.orchestrator import OrchestratorService
        from app.services.scheduler import SchedulerService
        from app.services.tooling import ToolingService
        from app.services.tts import TTSService

        log_info("Service imports complete")

        # Create service instances
        # Order matters: DB and Tooling first (foundation services)
        # Then Scheduler, TTS, STT (old or new), and finally Orchestrator
        log_info("Creating service instances...")
        db_service = DBService()
        tooling_service = ToolingService()
        scheduler_service = SchedulerService()
        tts_service = TTSService()
        orchestrator_service = OrchestratorService()

        log_info("Service instances created")

        # Start ConfigService first (needed by other services)
        try:
            from app.services.config import ConfigService

            config_service = ConfigService()
            await config_service.start()
            self.services.append(config_service)
            log_info("✓ ConfigService started")
        except Exception as e:
            log_error(f"Failed to start ConfigService: {e}", exc_info=True)
            raise

        # Start foundation services first (DB, Tooling)
        try:
            log_info("Starting foundation services (DB, Tooling)...")
            await asyncio.gather(db_service.start(), tooling_service.start())
            self.services.extend([db_service, tooling_service])
            log_info("Foundation services started")
        except Exception as e:
            log_error(f"Failed to start foundation services: {e}", exc_info=True)
            raise

        # Start scheduler service
        try:
            log_info("Starting Scheduler service...")
            await scheduler_service.start()
            self.services.append(scheduler_service)
            log_info("Scheduler service started")
        except Exception as e:
            log_error(f"Failed to start Scheduler service: {e}")
            raise

        # Use new modular streaming STT architecture
        log_info(">>> Starting streaming STT architecture (modular) <<<")
        await self._start_streaming_stt_services()
        log_info("STT services started")

        # Start remaining services (TTS, Orchestrator)
        try:
            log_info("Starting TTS and Orchestrator services...")
            await asyncio.gather(tts_service.start(), orchestrator_service.start())
            self.services.extend([tts_service, orchestrator_service])
            log_info("TTS and Orchestrator started")
        except Exception as e:
            log_error(f"Failed to start services: {e}")
            raise

        log_info(f"All {len(self.services)} services started successfully")

    async def _start_services_processes(self) -> None:
        """Start all services as separate processes (processes mode)."""
        log_info("Starting services in processes mode...")

        from app.shared.services.process_launcher import ProcessLauncher

        self.process_launcher = ProcessLauncher()

        # Service definitions: (service_name, module_path)
        services = [
            ("ConfigService", "app.services.config"),
            ("DBService", "app.services.db"),
            ("ToolingService", "app.services.tooling"),
            ("SchedulerService", "app.services.scheduler"),
            ("TTSService", "app.services.tts"),
            ("OrchestratorService", "app.services.orchestrator"),
        ]

        # Always start STT services (speech_to_text cannot be disabled via config)
        stt_services = [
            # Note: AudioInputService merged into STTCoordinatorService
            ("WakeWordService", "app.services.stt_wakeword"),
            ("TranscriptionService", "app.services.stt_transcription"),
            ("STTCoordinatorService", "app.services.stt_coordinator"),
        ]
        services.extend(stt_services)

        # Start services in order
        for service_name, module_path in services:
            try:
                self.process_launcher.start_service(service_name, module_path, daemon=False)
                log_info(f"✓ {service_name} process started")
                # Small delay between service starts
                await asyncio.sleep(0.5)
            except Exception as e:
                log_error(f"Failed to start {service_name} process: {e}", exc_info=True)
                raise

        log_info("All service processes started successfully")

    async def _start_streaming_stt_services(self) -> None:
        """Start new modular streaming STT services.

        Note: AudioInputService has been merged into STTCoordinatorService.
        Audio capture is now handled internally by the coordinator.
        """
        from app.services.stt_coordinator import STTCoordinatorService
        from app.services.stt_transcription import TranscriptionService
        from app.services.stt_wakeword import WakeWordService

        log_info(
            "Starting streaming STT services (Wake Word, Transcription, Coordinator with audio)..."
        )

        # Create service instances
        wake_word = WakeWordService()
        transcription = TranscriptionService()
        coordinator = STTCoordinatorService()  # Now includes audio capture

        # Start services in order:
        # 1. Wake Word & Transcription (can start in parallel, will consume audio from coordinator)
        # 2. Coordinator (starts audio capture and orchestrates the workflow)

        try:
            # Start wake word and transcription in parallel
            log_info("Starting Wake Word and Transcription services...")
            await asyncio.gather(wake_word.start(), transcription.start())
            self.services.extend([wake_word, transcription])
            log_info("Wake Word and Transcription services started")

            # Start coordinator last (includes audio capture)
            log_info("Starting STT Coordinator service (with audio capture)...")
            await coordinator.start()
            self.services.append(coordinator)
            log_info("STT Coordinator service started")

            log_info("All streaming STT services started successfully")

        except Exception as e:
            log_error(f"Failed to start streaming STT services: {e}")
            raise

    async def run(self) -> None:
        """Run the supervisor (blocks until shutdown signal)."""
        log_info("Aurora Supervisor running...")

        # Set up signal handlers (only works in main thread)
        try:
            loop = asyncio.get_event_loop()

            def signal_handler():
                log_info("Shutdown signal received")
                self.shutdown_event.set()

            # Register signal handlers (only works in main thread)
            for sig in (signal.SIGTERM, signal.SIGINT):
                loop.add_signal_handler(sig, signal_handler)

            log_info("Signal handlers registered")
        except (RuntimeError, ValueError) as e:
            # Signal handlers can only be registered in the main thread
            # When running with UI, supervisor runs in a background thread
            log_info(f"Signal handlers not registered (running in background thread): {e}")
            log_info("Supervisor will rely on shutdown_event for graceful shutdown")

        # Wait for shutdown signal
        await self.shutdown_event.wait()

        log_info("Shutting down...")

    async def shutdown(self) -> None:
        """Shutdown all services gracefully."""
        log_info("Stopping Aurora services...")

        # Stop gateway first (before services)
        await self._stop_gateway()

        if self._mode == "processes":
            # Stop all service processes
            if self.process_launcher:
                self.process_launcher.stop_all(timeout=10.0)
        else:
            # Stop all services in threads mode
            for service in reversed(self.services):  # Stop in reverse order
                try:
                    await service.stop()
                    log_info(f"Stopped {service.__class__.__name__}")
                except Exception as e:
                    log_error(f"Error stopping {service.__class__.__name__}: {e}", exc_info=True)

        # Stop message bus
        if self._bus:
            try:
                await self._bus.stop()
                log_info("Message bus stopped")
            except Exception as e:
                log_error(f"Error stopping bus: {e}", exc_info=True)

        self.shutdown_event.set()
        log_info("Supervisor shutdown complete")

    async def start(self) -> None:
        """Start the supervisor."""
        try:
            # 1. Initialize bus (custom logic)
            await self.initialize()

            # 2. Call BaseService.start() which handles subscriptions and calls on_start
            await super().start()

            # 3. Run main loop
            await self.run()
        finally:
            await self.shutdown()

    async def on_start(self) -> None:
        """Service-specific startup logic."""
        # Start services (thread mode) or wait for them (process mode)
        # Note: start_services() already calls _start_gateway() if enabled
        await self.start_services()

        # Subscribe to config changes for dynamic gateway control
        self._subscribe_to_config_changes()

    async def on_stop(self) -> None:
        """Service-specific shutdown logic."""
        # Stop gateway if running
        await self._stop_gateway()

    async def reload(self, config_section: str | None = None) -> None:
        """Reload service configuration."""
        # Reload gateway config if needed
        if config_section is None or config_section == "gateway":
            await self._reload_gateway_config()

    # =========================================================================
    # Gateway Management
    # =========================================================================

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
                # Return defaults if no config
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
            # Import gateway components
            from app.services.gateway.fastapi_app import create_gateway_app
            from app.services.gateway.registry_aggregator import RegistryAggregator

            # Create registry aggregator
            self._registry_aggregator = RegistryAggregator(
                bus=self._bus,
                mode=self._mode,
            )

            # Get gateway settings
            host = config.get("host", "0.0.0.0")
            port = config.get("port", 8000)
            request_timeout = config.get("request_timeout_s", 30.0)
            cors_config = config.get("cors", {})
            cors_origins = cors_config.get("origins", ["*"])
            cors_allow_credentials = cors_config.get("allow_credentials", True)

            # Get auth config
            auth_config = config.get("auth", {})
            auth_enabled = auth_config.get("enabled", False)
            auth_api_keys = auth_config.get("api_keys", [])

            # Create FastAPI app
            self._gateway_app = create_gateway_app(
                bus=self._bus,
                registry=self._registry_aggregator,
                cors_origins=cors_origins,
                cors_allow_credentials=cors_allow_credentials,
                auth_enabled=auth_enabled,
                auth_api_keys=auth_api_keys,
                request_timeout=request_timeout,
            )

            # Start uvicorn server in background
            import uvicorn

            uvicorn_config = uvicorn.Config(
                self._gateway_app,
                host=host,
                port=port,
                log_level="info",
                access_log=True,
            )
            self._gateway_server = uvicorn.Server(uvicorn_config)

            # Run in background task
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
            # Signal uvicorn to shutdown
            if self._gateway_server:
                self._gateway_server.should_exit = True

            # Cancel the background task
            if self._gateway_task and not self._gateway_task.done():
                self._gateway_task.cancel()
                with contextlib.suppress(asyncio.CancelledError, TimeoutError):
                    await asyncio.wait_for(self._gateway_task, timeout=5.0)

            # Stop registry aggregator
            if self._registry_aggregator:
                await self._registry_aggregator.stop()

            self._gateway_enabled = False
            log_info("Gateway stopped")

        except Exception as e:
            log_error(f"Error stopping gateway: {e}")

    async def _reload_gateway_config(self) -> None:
        """Reload gateway configuration dynamically.

        Handles:
        - Starting gateway if enabled and not running
        - Stopping gateway if disabled and running
        - Note: host/port changes require full restart
        """
        try:
            config = await self._get_gateway_config()
            should_be_enabled = config.get("enabled", False)

            if should_be_enabled and not self._gateway_enabled:
                # Gateway should be running but isn't - start it
                log_info("Gateway enabled via config - starting gateway")
                await self._start_gateway()

            elif not should_be_enabled and self._gateway_enabled:
                # Gateway is running but should be disabled - stop it
                log_info("Gateway disabled via config - stopping gateway")
                await self._stop_gateway()

            elif self._gateway_enabled:
                # Gateway is running and should stay running
                # TODO: Update CORS, auth settings dynamically if possible
                log_info("Gateway config reloaded (host/port changes require restart)")

        except Exception as e:
            log_error(f"Error reloading gateway config: {e}")

    @method_contract(
        method_id=SupervisorMethods.GET_STATUS,
        summary="Get status of all services",
        input_model=EmptyInput,
        output_model=GetStatusResponse,
        exposure="both",
    )
    async def _handle_get_status(self, request: EmptyInput) -> GetStatusResponse:
        """Handle GetStatus query."""
        statuses = []
        for service in self.services:
            # Basic status check
            is_running = getattr(service, "_started", False)
            name = getattr(
                service, "module", getattr(service, "service_name", str(type(service).__name__))
            )

            statuses.append(ServiceStatus(name=name, running=is_running, details={}))

        return GetStatusResponse(services=statuses, mode=self._mode)

    @method_contract(
        method_id=SupervisorMethods.RESTART_SERVICE,
        summary="Restart a specific service",
        input_model=ServiceControlCommand,
        output_model=ServiceControlResponse,
        exposure="internal",
    )
    async def _handle_restart_service(self, envelope: Envelope) -> None:
        """Handle RestartService command."""
        # TODO: Implement service restart logic
        # For now, just return success
        if envelope.reply_to:
            await self.bus.publish(
                envelope.reply_to,
                ServiceControlResponse(success=True, message="Not implemented yet"),
                event=False,
            )


# Convenience function for running supervisor
async def run_supervisor() -> None:
    """Run the Aurora supervisor."""
    supervisor = Supervisor()
    await supervisor.start()


# Entry point for running in threads mode
def main():
    """Main entry point for supervisor."""
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
    )

    try:
        asyncio.run(run_supervisor())
    except KeyboardInterrupt:
        log_info("Interrupted by user")
    except Exception as e:
        log_error(f"Supervisor error: {e}", exc_info=True)
        raise


if __name__ == "__main__":
    main()
