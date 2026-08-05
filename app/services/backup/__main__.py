"""Entry point for running BackupService as a standalone process."""

import sys
from pathlib import Path

project_root = Path(__file__).resolve().parent.parent.parent.parent
sys.path.insert(0, str(project_root))

from app.helpers.aurora_logger import log_error, log_info  # noqa: E402
from app.messaging import register_all_service_topics  # noqa: E402
from app.services.backup.service import BackupService  # noqa: E402
from app.shared.messaging.bus_init import initialize_bus_for_service  # noqa: E402
from app.shared.services.process_launcher import (  # noqa: E402
    ShutdownSignalWaiter,
    run_standalone_service,
)


async def main() -> None:
    """Run BackupService in process mode."""
    service_name = "BackupService"
    log_info(f"Starting {service_name} as standalone process...")
    bus = None
    service = None
    shutdown_waiter = ShutdownSignalWaiter(service_name)

    try:
        register_all_service_topics()
        bus = initialize_bus_for_service(service_name)
        await bus.start()

        service = BackupService()
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


def run() -> None:
    """Synchronous entry point for console script."""
    run_standalone_service(main)


if __name__ == "__main__":
    run()
