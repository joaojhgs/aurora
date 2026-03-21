"""Entry point for running Auth service in process mode."""

import asyncio
import sys
from pathlib import Path

# Ensure project root is on sys.path before any `app.*` imports (process-mode entrypoint).
_project_root = Path(__file__).resolve().parent.parent.parent.parent
sys.path.insert(0, str(_project_root))

from app.helpers.aurora_logger import log_error, log_info
from app.messaging import register_all_service_topics
from app.services.auth.service import AuthService
from app.shared.messaging.bus_init import initialize_bus_for_service


async def main() -> None:
    service_name = "AuthService"
    log_info(f"Starting {service_name} as standalone process...")
    bus = None
    try:
        register_all_service_topics()
        bus = initialize_bus_for_service("Auth")
        await bus.start()

        svc = AuthService()
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
            try:
                await bus.stop()
            except Exception:
                pass
        raise SystemExit(1) from e


if __name__ == "__main__":
    asyncio.run(main())
