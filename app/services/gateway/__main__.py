"""Entry point for running Gateway service in process mode."""

import asyncio
import sys
from contextlib import suppress
from pathlib import Path

_project_root = Path(__file__).resolve().parent.parent.parent.parent
sys.path.insert(0, str(_project_root))

from app.helpers.aurora_logger import log_error, log_info  # noqa: E402
from app.messaging import register_all_service_topics  # noqa: E402
from app.services.gateway.service import GatewayService  # noqa: E402
from app.shared.messaging.bus_init import initialize_bus_for_service  # noqa: E402


async def main() -> None:
    service_name = "GatewayService"
    log_info(f"Starting {service_name} as standalone process...")
    bus = None
    try:
        register_all_service_topics()
        bus = initialize_bus_for_service("Gateway")
        await bus.start()

        svc = GatewayService()
        await svc.start()

        log_info(f"{service_name} started successfully")
        try:
            await asyncio.Event().wait()
        except (KeyboardInterrupt, asyncio.CancelledError):
            log_info(f"Received shutdown signal for {service_name}")

        await svc.stop()
        await bus.stop()
        log_info(f"{service_name} stopped")
    except Exception as e:
        log_error(f"Error running {service_name}: {e}", exc_info=True)
        if bus is not None:
            with suppress(Exception):
                await bus.stop()
        raise SystemExit(1) from e


def run() -> None:
    """Synchronous entry point for console scripts."""
    asyncio.run(main())


if __name__ == "__main__":
    run()
