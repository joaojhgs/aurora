"""Unit tests for LatencyMonitor."""

import asyncio
import time
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.gateway.mesh.latency import LatencyMonitor
from app.services.gateway.mesh.models import PeerState


@pytest.fixture
def mock_rtc_client():
    client = MagicMock()
    client.send_to_peer = MagicMock(return_value=True)
    return client


@pytest.fixture
def mock_peer_registry():
    reg = MagicMock()
    reg.get_negotiated_peers = MagicMock(return_value=[
        PeerState(peer_id="peer-1", status="negotiated"),
        PeerState(peer_id="peer-2", status="negotiated"),
    ])
    reg.update_latency = AsyncMock()
    return reg


@pytest.fixture
def monitor(mock_rtc_client, mock_peer_registry):
    return LatencyMonitor(mock_rtc_client, mock_peer_registry, interval_s=0.1)


class TestLatencyMonitorLifecycle:
    """Tests for start/stop."""

    @pytest.mark.asyncio
    async def test_start_stop(self, monitor):
        await monitor.start()
        assert monitor._task is not None
        await monitor.stop()
        assert monitor._task is None
        assert monitor.get_pending_ping_count() == 0

    @pytest.mark.asyncio
    async def test_stop_without_start(self, monitor):
        await monitor.stop()  # Should not raise


class TestPingPong:
    """Tests for ping/pong RTT measurement."""

    def test_send_ping(self, monitor, mock_rtc_client):
        monitor._send_ping("peer-1")
        mock_rtc_client.send_to_peer.assert_called_once()
        call_args = mock_rtc_client.send_to_peer.call_args
        assert call_args[0][0] == "peer-1"  # peer_id
        assert monitor.get_pending_ping_count() == 1

    @pytest.mark.asyncio
    async def test_on_pong_calculates_rtt(self, monitor, mock_peer_registry):
        # Send a ping first
        monitor._send_ping("peer-1")
        assert monitor.get_pending_ping_count() == 1

        # Get the ping_id from pending pings
        ping_id = next(iter(monitor._pending_pings.keys()))

        # Simulate pong response
        monitor.on_pong("peer-1", {"id": ping_id, "ts": time.monotonic()})
        assert monitor.get_pending_ping_count() == 0

    def test_on_pong_wrong_peer(self, monitor):
        """Pong from wrong peer pops the entry (consumed) and logs a warning."""
        monitor._send_ping("peer-1")
        ping_id = next(iter(monitor._pending_pings.keys()))

        # Pong from a different peer — entry is popped during lookup
        monitor.on_pong("peer-99", {"id": ping_id, "ts": time.monotonic()})
        # Entry was consumed (popped) despite peer mismatch
        assert monitor.get_pending_ping_count() == 0

    def test_on_pong_unknown_id(self, monitor):
        """Pong with unknown ID should be ignored."""
        monitor.on_pong("peer-1", {"id": "unknown-id", "ts": time.monotonic()})
        # Should not raise

    def test_on_pong_missing_id(self, monitor):
        """Pong without ID should be ignored."""
        monitor.on_pong("peer-1", {"ts": time.monotonic()})


class TestStaleCleanup:
    """Tests for cleanup_stale_pings."""

    def test_cleanup_stale_pings(self, monitor):
        # Add some "old" pings
        old_time = time.monotonic() - 120.0
        monitor._pending_pings["old-1"] = ("peer-1", old_time)
        monitor._pending_pings["old-2"] = ("peer-2", old_time)
        monitor._pending_pings["recent"] = ("peer-3", time.monotonic())

        removed = monitor.cleanup_stale_pings(max_age_s=60.0)
        assert removed == 2
        assert monitor.get_pending_ping_count() == 1
        assert "recent" in monitor._pending_pings

    def test_cleanup_no_stale(self, monitor):
        monitor._pending_pings["recent"] = ("peer-1", time.monotonic())
        removed = monitor.cleanup_stale_pings(max_age_s=60.0)
        assert removed == 0


class TestPingLoop:
    """Tests for the periodic ping loop."""

    @pytest.mark.asyncio
    async def test_ping_loop_sends_pings(self, monitor, mock_rtc_client, mock_peer_registry):
        """Start monitor and verify pings are sent after interval."""
        await monitor.start()
        # Wait for at least one ping cycle
        await asyncio.sleep(0.25)
        await monitor.stop()

        # Should have sent pings to both peers
        assert mock_rtc_client.send_to_peer.call_count >= 2
