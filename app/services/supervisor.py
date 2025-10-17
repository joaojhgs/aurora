"""Supervisor for managing Aurora services in parallel architecture.

The supervisor:
- Initializes the message bus (LocalBus or BullMQBus)
- Starts all services
- Manages service lifecycle
- Handles graceful shutdown
"""

from __future__ import annotations

import asyncio
import logging
import signal
from typing import Any

from app.config.config_manager import config_manager
from app.helpers.aurora_logger import log_error, log_info, log_warning
from app.messaging import register_all_service_topics
from app.messaging.bus import MessageBus
from app.messaging.bus_runtime import set_bus
from app.messaging.local_bus import LocalBus

logger = logging.getLogger(__name__)


class Supervisor:
    """Supervisor for managing Aurora services.

    Responsibilities:
    - Initialize message bus based on configuration
    - Start all services in the correct order
    - Handle graceful shutdown
    - Manage service health and restarts
    """

    def __init__(self):
        """Initialize the supervisor."""
        self.bus: MessageBus | None = None
        self.services: list[Any] = []
        self.shutdown_event = asyncio.Event()
        self._mode = "threads"  # "threads" or "processes"

    async def initialize(self) -> None:
        """Initialize the supervisor and message bus."""
        log_info("Initializing Aurora Supervisor...")

        # Register all service topics in the event registry FIRST
        log_info("Registering service topics...")
        register_all_service_topics()

        # Get architecture mode from config
        try:
            self._mode = config_manager.get("general.architecture.mode", "threads")
        except Exception:
            log_warning("Architecture mode not configured, using 'threads'")
            self._mode = "threads"

        log_info(f"Architecture mode: {self._mode}")

        # Initialize message bus based on mode
        if self._mode == "threads":
            await self._initialize_local_bus()
        elif self._mode == "processes":
            await self._initialize_bullmq_bus()
        else:
            raise ValueError(f"Unknown architecture mode: {self._mode}")

        # Set global bus instance
        set_bus(self.bus)

        log_info("Supervisor initialized")

    async def _initialize_local_bus(self) -> None:
        """Initialize LocalBus for thread mode."""
        log_info("Initializing LocalBus (thread mode)...")

        self.bus = LocalBus(
            command_queue_size=1000,
            event_queue_size=5000,
        )

        await self.bus.start()
        log_info("LocalBus initialized")

    async def _initialize_bullmq_bus(self) -> None:
        """Initialize BullMQBus for process mode."""
        log_info("Initializing BullMQBus (process mode)...")

        from app.messaging.bullmq_bus import BullMQBus

        # Get Redis URL from config
        try:
            redis_url = config_manager.get("messaging.redis.url", "redis://localhost:6379")
        except Exception:
            log_warning("Redis URL not configured, using default")
            redis_url = "redis://localhost:6379"

        self.bus = BullMQBus(redis_url=redis_url)
        await self.bus.start()
        log_info("BullMQBus initialized")

    async def start_services(self) -> None:
        """Start all Aurora services in parallel."""
        print(">>> SUPERVISOR: start_services() called!", flush=True)
        log_info("Starting Aurora services...")

        # Import services
        from app.db import DBService
        from app.orchestrator import OrchestratorService
        from app.scheduler import SchedulerService
        from app.tooling import ToolingService
        from app.tts import TTSService

        log_info("✓ Service imports complete")

        # Create service instances
        # Order matters: DB and Tooling first (foundation services)
        # Then Scheduler, TTS, STT (old or new), and finally Orchestrator
        log_info("Creating service instances...")
        db_service = DBService(self.bus)
        tooling_service = ToolingService(self.bus)
        scheduler_service = SchedulerService(self.bus)
        tts_service = TTSService(self.bus)
        orchestrator_service = OrchestratorService(self.bus)

        log_info("✓ Service instances created")

        # Start foundation services first (DB, Tooling)
        try:
            log_info("Starting foundation services (DB, Tooling)...")
            await asyncio.gather(db_service.start(), tooling_service.start())
            self.services.extend([db_service, tooling_service])
            log_info("✓ Foundation services started")
        except Exception as e:
            log_error(f"Failed to start foundation services: {e}")
            raise

        # Start scheduler service
        try:
            log_info("Starting Scheduler service...")
            await scheduler_service.start()
            self.services.append(scheduler_service)
            log_info("✓ Scheduler service started")
        except Exception as e:
            log_error(f"Failed to start Scheduler service: {e}")
            raise

        # Use new modular streaming STT architecture
        log_info(">>> Starting streaming STT architecture (modular) <<<")
        await self._start_streaming_stt_services()
        log_info("✓ STT services started")

        # Start remaining services (TTS, Orchestrator)
        try:
            log_info("Starting TTS and Orchestrator services...")
            await asyncio.gather(tts_service.start(), orchestrator_service.start())
            self.services.extend([tts_service, orchestrator_service])
            log_info("✓ TTS and Orchestrator started")
        except Exception as e:
            log_error(f"Failed to start services: {e}")
            raise

        log_info(f"✅ All {len(self.services)} services started successfully")

    async def _start_streaming_stt_services(self) -> None:
        """Start new modular streaming STT services."""
        from app.stt_audio_input import AudioInputService
        from app.stt_coordinator import STTCoordinatorService
        from app.stt_transcription import TranscriptionService
        from app.stt_wakeword import WakeWordService

        log_info("Starting streaming STT services (Audio Input, Wake Word, Transcription, Coordinator)...")

        # Create service instances
        audio_input = AudioInputService(self.bus)
        wake_word = WakeWordService(self.bus)
        transcription = TranscriptionService(self.bus)
        coordinator = STTCoordinatorService(self.bus)

        # Start services in order:
        # 1. Audio Input (provides audio stream)
        # 2. Wake Word & Transcription (consume audio stream - can start in parallel)
        # 3. Coordinator (orchestrates the workflow)

        try:
            # Start audio input first
            log_info("Starting Audio Input service...")
            await audio_input.start()
            self.services.append(audio_input)
            log_info("Audio Input service started")

            # Start wake word and transcription in parallel
            log_info("Starting Wake Word and Transcription services...")
            await asyncio.gather(wake_word.start(), transcription.start())
            self.services.extend([wake_word, transcription])
            log_info("Wake Word and Transcription services started")

            # Start coordinator last
            log_info("Starting STT Coordinator service...")
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

        # Stop services in reverse order
        for service in reversed(self.services):
            try:
                await service.stop()
                log_info(f"Stopped {service.__class__.__name__}")
            except Exception as e:
                log_error(f"Error stopping {service.__class__.__name__}: {e}")

        # Stop message bus
        if self.bus:
            await self.bus.stop()
            log_info("Message bus stopped")

        log_info("Supervisor shutdown complete")

    async def start(self) -> None:
        """Start the supervisor (convenience method)."""
        try:
            await self.initialize()
            await self.start_services()
            await self.run()
        finally:
            await self.shutdown()


# Convenience function for running supervisor
async def run_supervisor() -> None:
    """Run the Aurora supervisor."""
    supervisor = Supervisor()
    await supervisor.start()


# Entry point for running in threads mode
def main():
    """Main entry point for supervisor."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")

    try:
        asyncio.run(run_supervisor())
    except KeyboardInterrupt:
        log_info("Interrupted by user")
    except Exception as e:
        log_error(f"Supervisor error: {e}", exc_info=True)
        raise


if __name__ == "__main__":
    main()
