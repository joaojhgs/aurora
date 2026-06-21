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
from typing import Any, Literal

from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.messaging.bus import MessageBus
from app.messaging.bus_runtime import set_bus
from app.messaging.local_bus import LocalBus
from app.shared.contracts.models.common import EmptyInput
from app.shared.contracts.models.supervisor import (
    GetStatusResponse,
    ServiceControlAvailability,
    ServiceControlCommand,
    ServiceControlResponse,
    ServiceStatus,
    SupervisorMethods,
    SupervisorModule,
)
from app.shared.contracts.registry import method_contract
from app.shared.services.base_service import BaseService


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

    def _control_capabilities(self) -> list[ServiceControlAvailability]:
        """Return current service-control support advertised to UI/SDK clients."""
        reason = (
            "Supervisor lifecycle mutation is intentionally disabled until a safe "
            "per-service executor, dependency ordering, and self-protection policy land."
        )
        return [
            ServiceControlAvailability(
                operation="restart",
                method_id=SupervisorMethods.RESTART_SERVICE,
                required_perms=[SupervisorMethods.RESTART_SERVICE],
                reason=reason,
            ),
            ServiceControlAvailability(
                operation="stop",
                method_id=SupervisorMethods.STOP_SERVICE,
                required_perms=[SupervisorMethods.STOP_SERVICE],
                reason=reason,
            ),
            ServiceControlAvailability(
                operation="start",
                method_id=SupervisorMethods.START_SERVICE,
                required_perms=[SupervisorMethods.START_SERVICE],
                reason=reason,
            ),
        ]

    def _control_capability_map(self) -> dict[str, ServiceControlAvailability]:
        return {cap.operation: cap for cap in self._control_capabilities()}

    def _gated_control_response(
        self,
        operation: Literal["restart", "stop", "start"],
        data: ServiceControlCommand,
    ) -> ServiceControlResponse:
        """Return explicit disabled-state response for service control commands."""
        return ServiceControlResponse(
            success=False,
            operation=operation,
            service_name=data.service_name,
            status="unsupported",
            control_state="internal_only",
            admin_action_required=True,
            message=(
                f"Supervisor {operation} is intentionally gated as internal-only and "
                "unsupported until safe lifecycle orchestration is implemented."
            ),
        )

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

        # In process mode each process has a partial local contract registry.
        # Cross-service RPC must be allowed even when this process only imported
        # supervisor contracts.
        self._bus = BullMQBus(redis_url=redis_url, validate_topics=False)
        await self._bus.start()
        log_info("BullMQBus initialized")

    async def start_services(self) -> None:
        """Start all Aurora services in parallel."""
        log_info("Starting Aurora services...")

        if self._mode == "processes":
            await self._start_services_processes()
        else:
            await self._start_services_threads()

    async def _start_services_threads(self) -> None:
        """Start all services in threads mode (same process)."""
        log_info("Starting services in threads mode...")

        # Import services
        from app.services.auth import AuthService
        from app.services.backup import BackupService
        from app.services.config import ConfigService
        from app.services.db import DBService
        from app.services.gateway import GatewayService
        from app.services.orchestrator import OrchestratorService
        from app.services.scheduler import SchedulerService
        from app.services.tooling import ToolingService

        log_info("Service imports complete")

        # Create service instances
        # Order matters: Config → DB → Auth → Tooling (foundation services)
        # Then Scheduler, TTS, STT, Orchestrator, and finally Gateway
        log_info("Creating service instances...")
        config_service = ConfigService()
        db_service = DBService()
        auth_service = AuthService()
        backup_service = BackupService()
        tooling_service = ToolingService()
        scheduler_service = SchedulerService()
        orchestrator_service = OrchestratorService()
        gateway_service = GatewayService()

        log_info("Service instances created")

        # Start ConfigService first (needed by other services)
        try:
            await config_service.start()
            self.services.append(config_service)
            log_info("✓ ConfigService started")
        except Exception as e:
            log_error(f"Failed to start ConfigService: {e}", exc_info=True)
            raise

        # Start DB service first (Tooling depends on DB for RAG sync)
        try:
            log_info("Starting DB service...")
            await db_service.start()
            self.services.append(db_service)
            log_info("✓ DB service started")
        except Exception as e:
            log_error(f"Failed to start DB service: {e}", exc_info=True)
            raise

        # Start Auth service (depends on DB, Gateway depends on Auth)
        try:
            log_info("Starting Auth service...")
            await auth_service.start()
            self.services.append(auth_service)
            log_info("✓ Auth service started")
        except Exception as e:
            log_error(f"Failed to start Auth service: {e}", exc_info=True)
            raise

        # Start Backup service (depends on Config and DB contracts)
        try:
            log_info("Starting Backup service...")
            await backup_service.start()
            self.services.append(backup_service)
            log_info("✓ Backup service started")
        except Exception as e:
            log_error(f"Failed to start Backup service: {e}", exc_info=True)
            raise

        # Start Tooling service (needs DB to be ready for tool sync)
        try:
            log_info("Starting Tooling service...")
            await tooling_service.start()
            self.services.append(tooling_service)
            log_info("✓ Tooling service started")
        except Exception as e:
            log_error(f"Failed to start Tooling service: {e}", exc_info=True)
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

        # Use new modular streaming STT architecture only when enabled. Optional
        # STT dependencies should not be imported when the services are inactive.
        log_info(">>> Starting streaming STT architecture (modular) if enabled <<<")
        await self._start_streaming_stt_services()

        # Start remaining services (TTS if enabled, Orchestrator, Gateway)
        try:
            log_info("Starting optional TTS, Orchestrator, and Gateway services...")
            services_to_start = [orchestrator_service, gateway_service]
            from app.shared.config.keys import ConfigKeys

            if await self._get_config_bool(ConfigKeys.services.tts.enabled, default=False):
                from app.services.tts import TTSService

                services_to_start.insert(0, TTSService())
            else:
                log_info("TTS service disabled; skipping optional TTS import/start")

            await asyncio.gather(*(service.start() for service in services_to_start))
            self.services.extend(services_to_start)
            log_info("Optional TTS, Orchestrator and Gateway startup completed")
        except Exception as e:
            log_error(f"Failed to start services: {e}")
            raise

        log_info(f"All {len(self.services)} services started successfully")

    async def _start_services_processes(self) -> None:
        """Start all services as separate processes (processes mode)."""
        log_info("Starting services in processes mode...")

        from app.shared.services.process_launcher import ProcessLauncher

        self.process_launcher = ProcessLauncher()

        from app.shared.config.keys import ConfigKeys

        # Service definitions: (service_name, module_path)
        services = [
            ("ConfigService", "app.services.config"),
            ("DBService", "app.services.db"),
            ("AuthService", "app.services.auth"),
            ("BackupService", "app.services.backup"),
            ("ToolingService", "app.services.tooling"),
            ("SchedulerService", "app.services.scheduler"),
            ("OrchestratorService", "app.services.orchestrator"),
            ("GatewayService", "app.services.gateway"),
        ]

        if await self._get_config_bool(ConfigKeys.services.tts.enabled, default=False):
            services.append(("TTSService", "app.services.tts"))
        else:
            log_info("TTS service disabled; skipping optional TTS process")

        if await self._get_config_bool(ConfigKeys.services.stt.wakeword.enabled, default=False):
            services.append(("WakeWordService", "app.services.stt_wakeword"))
        if await self._get_config_bool(
            ConfigKeys.services.stt.transcription.enabled, default=False
        ):
            services.append(("TranscriptionService", "app.services.stt_transcription"))
        if await self._get_config_bool(ConfigKeys.services.stt.coordinator.enabled, default=False):
            services.append(("STTCoordinatorService", "app.services.stt_coordinator"))

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
        from app.shared.config.keys import ConfigKeys

        wake_enabled = await self._get_config_bool(
            ConfigKeys.services.stt.wakeword.enabled, default=False
        )
        transcription_enabled = await self._get_config_bool(
            ConfigKeys.services.stt.transcription.enabled, default=False
        )
        coordinator_enabled = await self._get_config_bool(
            ConfigKeys.services.stt.coordinator.enabled, default=False
        )

        if not (wake_enabled or transcription_enabled or coordinator_enabled):
            log_info("All STT services disabled; skipping optional STT imports/start")
            return

        log_info(
            "Starting streaming STT services (Wake Word, Transcription, Coordinator with audio)..."
        )

        try:
            first_phase = []
            if wake_enabled:
                from app.services.stt_wakeword import WakeWordService

                first_phase.append(WakeWordService())
            if transcription_enabled:
                from app.services.stt_transcription import TranscriptionService

                first_phase.append(TranscriptionService())

            if first_phase:
                log_info("Starting enabled Wake Word and Transcription services...")
                await asyncio.gather(*(service.start() for service in first_phase))
                self.services.extend(first_phase)
                log_info("Enabled Wake Word and Transcription services started")

            if coordinator_enabled:
                from app.services.stt_coordinator import STTCoordinatorService

                log_info("Starting STT Coordinator service (with audio capture)...")
                coordinator = STTCoordinatorService()
                await coordinator.start()
                self.services.append(coordinator)
                log_info("STT Coordinator service started")

            log_info("All streaming STT services started successfully")

        except Exception as e:
            log_error(f"Failed to start streaming STT services: {e}")
            raise

    async def _get_config_bool(self, key_path: str, default: bool) -> bool:
        """Read a boolean config value after ConfigService is available."""
        try:
            from app.services.config.config_manager import ConfigManager

            return bool(ConfigManager().get(str(key_path), default))
        except Exception as e:
            log_warning(f"Could not read {key_path} from local config: {e}")

        try:
            from app.shared.config.interface import ConfigAPI

            value = await ConfigAPI().aget(key_path, default=default, config_timeout=20.0)
            return bool(value)
        except Exception as e:
            log_warning(f"Could not read {key_path} from ConfigService; using {default}: {e}")
            return default

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
        await self.start_services()

    async def on_stop(self) -> None:
        """Service-specific shutdown logic."""
        pass

    async def reload(self, config_section: str | None = None) -> None:
        """Reload service configuration."""
        pass

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
        control_capabilities = self._control_capabilities()
        control_map = self._control_capability_map()
        for service in self.services:
            # Basic status check
            is_running = getattr(service, "_started", False)
            name = getattr(
                service, "module", getattr(service, "service_name", str(type(service).__name__))
            )

            statuses.append(
                ServiceStatus(
                    name=name,
                    running=is_running,
                    details={},
                    controls=control_map,
                )
            )

        return GetStatusResponse(
            services=statuses,
            mode=self._mode,
            control_capabilities=control_capabilities,
        )

    @method_contract(
        method_id=SupervisorMethods.RESTART_SERVICE,
        summary="Restart a specific service",
        input_model=ServiceControlCommand,
        output_model=ServiceControlResponse,
        exposure="internal",
        method_type="manage",
        required_perms=[SupervisorMethods.RESTART_SERVICE],
    )
    async def _handle_restart_service(self, data: ServiceControlCommand) -> ServiceControlResponse:
        """Handle RestartService command."""
        return self._gated_control_response("restart", data)

    @method_contract(
        method_id=SupervisorMethods.STOP_SERVICE,
        summary="Stop a specific service",
        input_model=ServiceControlCommand,
        output_model=ServiceControlResponse,
        exposure="internal",
        method_type="manage",
        required_perms=[SupervisorMethods.STOP_SERVICE],
    )
    async def _handle_stop_service(self, data: ServiceControlCommand) -> ServiceControlResponse:
        """Handle StopService command."""
        return self._gated_control_response("stop", data)

    @method_contract(
        method_id=SupervisorMethods.START_SERVICE,
        summary="Start a specific service",
        input_model=ServiceControlCommand,
        output_model=ServiceControlResponse,
        exposure="internal",
        method_type="manage",
        required_perms=[SupervisorMethods.START_SERVICE],
    )
    async def _handle_start_service(self, data: ServiceControlCommand) -> ServiceControlResponse:
        """Handle StartService command."""
        return self._gated_control_response("start", data)


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
