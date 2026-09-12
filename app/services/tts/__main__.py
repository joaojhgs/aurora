"""Entry point for running TTSService as a standalone process."""

import sys
from pathlib import Path

from app.helpers.aurora_logger import log_error, log_info
from app.messaging import register_all_service_topics
from app.services.tts.service import TTSService
from app.shared.messaging.bus_init import initialize_bus_for_service
from app.shared.services.process_launcher import (
    ShutdownSignalWaiter,
    run_standalone_service,
)

project_root = Path(__file__).parent.parent.parent.parent
sys.path.insert(0, str(project_root))


async def main():
    """Main entry point for TTSService process."""
    service_name = "TTSService"
    log_info(f"Starting {service_name} as standalone process...")
    bus = None
    service = None
    shutdown_waiter = ShutdownSignalWaiter(service_name)

    try:
        register_all_service_topics()
        bus = initialize_bus_for_service(service_name)
        await bus.start()

        service = TTSService()
        await service.start()

        log_info(f"{service_name} started successfully")

        await shutdown_waiter.wait()
    except Exception as e:
        log_error(f"Error running {service_name}: {e}", exc_info=True)
        sys.exit(1)
    finally:
        shutdown_waiter.close()
        try:
            if service is not None:
                await service.stop()
        finally:
            if bus is not None:
                await bus.stop()
            log_info(f"{service_name} stopped")


def run():
    """Synchronous entry point for console script."""
    run_standalone_service(main)


if __name__ == "__main__":
    run()
