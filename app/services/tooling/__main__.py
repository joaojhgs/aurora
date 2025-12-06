"""Entry point for running ToolingService as a standalone process."""

import asyncio
import sys
from pathlib import Path

from app.helpers.aurora_logger import log_error, log_info
from app.messaging import register_all_service_topics
from app.services.tooling.service import ToolingService
from app.shared.messaging.bus_init import initialize_bus_for_service

project_root = Path(__file__).parent.parent.parent.parent
sys.path.insert(0, str(project_root))


async def main():
    """Main entry point for ToolingService process."""
    service_name = "ToolingService"
    log_info(f"Starting {service_name} as standalone process...")

    try:
        register_all_service_topics()
        bus = initialize_bus_for_service(service_name)
        await bus.start()

        service = ToolingService()
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


if __name__ == "__main__":
    asyncio.run(main())
