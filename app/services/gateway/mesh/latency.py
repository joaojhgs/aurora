"""Latency monitoring for P2P mesh peers.

Periodically sends ping messages to all connected peers and measures
round-trip time (RTT). Results are stored in the PeerRegistry for
use by the routing table's peer selection algorithm.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from collections import deque
from statistics import median
from typing import TYPE_CHECKING

from app.helpers.aurora_logger import log_debug, log_warning

if TYPE_CHECKING:
    from app.services.gateway.mesh.peer_registry import PeerRegistry
    from app.services.gateway.webrtc.rtc_client import RTCClient


class LatencyMonitor:
    """Periodically measures RTT to all connected mesh peers.

    Uses ping/pong messages over WebRTC DataChannels. The RTCClient
    handles sending pings and receiving pongs; this class manages
    the timing loop and RTT calculation.
    """

    def __init__(
        self,
        rtc_client: RTCClient,
        peer_registry: PeerRegistry,
        interval_s: float = 30.0,
    ) -> None:
        self._rtc_client = rtc_client
        self._registry = peer_registry
        self._interval = interval_s
        # Maps ping_id → (peer_id, send_monotonic_time)
        self._pending_pings: dict[str, tuple[str, float]] = {}
        # A small median window prevents one busy event-loop turn from
        # becoming the routing latency for a full monitoring interval.
        self._recent_rtts: dict[str, deque[float]] = {}
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        """Start the periodic ping loop."""
        self._task = asyncio.create_task(self._ping_loop())
        log_debug(f"LatencyMonitor started (interval={self._interval}s)")

    async def stop(self) -> None:
        """Stop the periodic ping loop."""
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        self._pending_pings.clear()
        self._recent_rtts.clear()

    async def _ping_loop(self) -> None:
        """Continuously ping all connected peers at the configured interval."""
        while True:
            try:
                # Clean up pings that never received a pong (leak prevention)
                stale_count = self.cleanup_stale_pings(max_age_s=self._interval * 3)
                if stale_count:
                    log_debug(f"LatencyMonitor: Cleaned up {stale_count} stale pings")
                await self._ping_all_peers()
                await asyncio.sleep(self._interval)
            except asyncio.CancelledError:
                break
            except Exception as e:
                log_warning(f"LatencyMonitor: Error in ping loop: {e}")

    async def _ping_all_peers(self) -> None:
        """Send a ping to every negotiated peer."""
        peers = self._registry.get_negotiated_peers()
        for peer in peers:
            try:
                self.ping_peer(peer.peer_id)
            except Exception as e:
                log_debug(f"LatencyMonitor: Failed to ping {peer.peer_id}: {e}")

    def ping_peer(self, peer_id: str) -> bool:
        """Send one tracked latency ping to a peer.

        Args:
            peer_id: Target peer identifier

        Returns:
            True when the ping was sent and is awaiting a pong.
        """
        import json
        import uuid

        ping_id = uuid.uuid4().hex[:8]
        send_time = time.monotonic()
        self._pending_pings[ping_id] = (peer_id, send_time)

        msg = {
            "type": "ping",
            "id": ping_id,
            "ts": send_time,
        }
        try:
            sent = self._rtc_client.send_to_peer(peer_id, json.dumps(msg))
        except Exception:
            self._pending_pings.pop(ping_id, None)
            raise
        if not sent:
            self._pending_pings.pop(ping_id, None)
            return False
        return True

    def reset_peer(self, peer_id: str) -> None:
        """Discard stale samples before measuring a newly negotiated session."""
        self._recent_rtts.pop(peer_id, None)
        for ping_id, (pending_peer_id, _) in list(self._pending_pings.items()):
            if pending_peer_id == peer_id:
                self._pending_pings.pop(ping_id, None)

    def on_pong(self, peer_id: str, msg: dict) -> None:
        """Handle a pong response and calculate RTT.

        Called by PeerBridge (or RTCClient) when a pong is received.

        Args:
            peer_id: Peer that sent the pong
            msg: Parsed pong message with 'id' and 'ts' fields
        """
        ping_id = msg.get("id")
        if not ping_id:
            return

        entry = self._pending_pings.pop(ping_id, None)
        if not entry:
            log_debug(f"LatencyMonitor: Received pong {ping_id} with no matching ping")
            return

        stored_peer_id, send_time = entry
        if stored_peer_id != peer_id:
            log_warning(
                f"LatencyMonitor: Pong {ping_id} peer mismatch "
                f"(expected={stored_peer_id}, got={peer_id})"
            )
            return

        rtt_ms = (time.monotonic() - send_time) * 1000
        samples = self._recent_rtts.setdefault(peer_id, deque(maxlen=3))
        samples.append(rtt_ms)
        route_rtt_ms = float(median(samples))
        log_debug(
            f"LatencyMonitor: Peer {peer_id} RTT = {rtt_ms:.1f}ms "
            f"(rolling median={route_rtt_ms:.1f}ms)"
        )

        # Update the registry asynchronously
        asyncio.create_task(self._registry.update_latency(peer_id, route_rtt_ms))

    def get_pending_ping_count(self) -> int:
        """Get the number of pending (unanswered) pings.

        Returns:
            Number of pending pings
        """
        return len(self._pending_pings)

    def cleanup_stale_pings(self, max_age_s: float = 60.0) -> int:
        """Remove pending pings older than max_age_s.

        Args:
            max_age_s: Maximum age in seconds for a pending ping

        Returns:
            Number of removed stale pings
        """
        now = time.monotonic()
        stale = [pid for pid, (_, ts) in self._pending_pings.items() if (now - ts) > max_age_s]
        for pid in stale:
            self._pending_pings.pop(pid, None)
        return len(stale)
