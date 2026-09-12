"""Entry point for running ConfigService as a standalone process.

This module allows the ConfigService to run in its own OS process,
enabling true microservices architecture with process isolation.
"""

import sys
from pathlib import Path

# Ensure project root is on sys.path before any `app.*` imports (process-mode entrypoint).
project_root = Path(__file__).resolve().parent.parent.parent.parent
sys.path.insert(0, str(project_root))

from app.helpers.aurora_logger import log_error, log_info  # noqa: E402
from app.messaging import register_all_service_topics  # noqa: E402
from app.services.config.service import ConfigService  # noqa: E402
from app.shared.messaging.bus_init import initialize_bus_for_service  # noqa: E402
from app.shared.services.process_launcher import (  # noqa: E402
    ShutdownSignalWaiter,
    run_standalone_service,
)


async def main():
    """Main entry point for ConfigService process."""
    service_name = "ConfigService"
    log_info(f"Starting {service_name} as standalone process...")
    bus = None
    service = None
    shutdown_waiter = ShutdownSignalWaiter(service_name)

    try:
        # Register all service topics
        register_all_service_topics()

        # Initialize bus for this service (processes mode)
        bus = initialize_bus_for_service(service_name)
        await bus.start()

        # Create and start service
        service = ConfigService()
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
