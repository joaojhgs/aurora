"""Entry point for running ConfigService as a standalone process.

This module allows the ConfigService to run in its own OS process,
enabling true microservices architecture with process isolation.
"""

import asyncio
import sys
from pathlib import Path

from app.helpers.aurora_logger import log_error, log_info
from app.messaging import register_all_service_topics
from app.services.config.service import ConfigService
from app.shared.messaging.bus_init import initialize_bus_for_service

# Add project root to path
project_root = Path(__file__).parent.parent.parent.parent
sys.path.insert(0, str(project_root))


async def main():
    """Main entry point for ConfigService process."""
    service_name = "ConfigService"
    log_info(f"Starting {service_name} as standalone process...")

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

        # Keep service running
        try:
            await asyncio.Event().wait()
        except KeyboardInterrupt:
            log_info(f"Received shutdown signal for {service_name}")

        # Stop service
        await service.stop()
        await bus.stop()

        log_info(f"{service_name} stopped")
    except Exception as e:
        log_error(f"Error running {service_name}: {e}", exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
