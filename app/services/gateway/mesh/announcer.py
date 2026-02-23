"""Periodic manifest re-announcer for P2P mesh.

Ensures connected peers stay up-to-date with our service capabilities.
Uses the ``registry_announce_interval_s`` configuration setting.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import TYPE_CHECKING

from app.helpers.aurora_logger import log_debug, log_info, log_warning

if TYPE_CHECKING:
    from app.services.gateway.webrtc.rtc_client import RTCClient


class MeshAnnouncer:
    """Periodically re-announces this node's manifest to all mesh peers.

    This ensures that:
    - Peers that missed the initial manifest exchange get updated.
    - Contract changes (hot-reload) are propagated without restart.
    - Stale peers that recover automatically receive fresh manifests.
    """

    def __init__(
        self,
        rtc_client: RTCClient,
        interval_s: float = 60.0,
    ) -> None:
        self._rtc_client = rtc_client
        self._interval = interval_s
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        """Start the periodic re-announcement loop."""
        self._task = asyncio.create_task(self._announce_loop())
        log_info(f"MeshAnnouncer started (interval={self._interval}s)")

    async def stop(self) -> None:
        """Stop the periodic re-announcement loop."""
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    async def _announce_loop(self) -> None:
        """Continuously re-announce manifest at the configured interval."""
        while True:
            try:
                await asyncio.sleep(self._interval)
                await self._rtc_client.reannounce_manifest()
            except asyncio.CancelledError:
                break
            except Exception as e:
                log_warning(f"MeshAnnouncer: Error in announce loop: {e}")

    async def announce_now(self) -> None:
        """Trigger an immediate re-announcement (e.g., after config reload)."""
        try:
            await self._rtc_client.reannounce_manifest()
        except Exception as e:
            log_warning(f"MeshAnnouncer: Immediate announce failed: {e}")
