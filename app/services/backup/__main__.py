"""Entry point for running BackupService as a standalone process."""

import asyncio
import sys
from pathlib import Path

project_root = Path(__file__).resolve().parent.parent.parent.parent
sys.path.insert(0, str(project_root))

from app.helpers.aurora_logger import log_error, log_info  # noqa: E402
from app.messaging import register_all_service_topics  # noqa: E402
from app.services.backup.service import BackupService  # noqa: E402
from app.shared.messaging.bus_init import initialize_bus_for_service  # noqa: E402


async def main() -> None:
    """Run BackupService in process mode."""
    service_name = "BackupService"
    log_info(f"Starting {service_name} as standalone process...")

    try:
        register_all_service_topics()
        bus = initialize_bus_for_service(service_name)
        await bus.start()

        service = BackupService()
        await service.start()

        log_info(f"{service_name} started successfully")

        try:
            await asyncio.Event().wait()
        except KeyboardInterrupt:
            log_info(f"Received shutdown signal for {service_name}")

        await service.stop()
        await bus.stop()
        log_info(f"{service_name} stopped")
    except Exception as e:
        log_error(f"Error running {service_name}: {e}", exc_info=True)
        sys.exit(1)


def run() -> None:
    """Synchronous entry point for console script."""
    asyncio.run(main())


if __name__ == "__main__":
    run()
