"""Entry point for running Auth service in process mode."""

import asyncio

from app.services.auth.service import AuthService
from app.shared.messaging.bus_init import initialize_bus_for_service


async def main() -> None:
    initialize_bus_for_service("Auth")
    svc = AuthService()
    await svc.start()

    # Keep running until interrupted
    try:
        while True:
            await asyncio.sleep(1)
    except (KeyboardInterrupt, asyncio.CancelledError):
        await svc.stop()


if __name__ == "__main__":
    asyncio.run(main())
