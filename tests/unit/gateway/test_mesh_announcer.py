"""Periodic mesh announcement regression coverage."""

from unittest.mock import AsyncMock

import pytest

from app.services.gateway.mesh.announcer import MeshAnnouncer


@pytest.mark.asyncio
async def test_mesh_announcement_refreshes_presence_before_manifest() -> None:
    rtc_client = AsyncMock()
    order: list[str] = []
    rtc_client.refresh_presence.side_effect = lambda: order.append("presence")
    rtc_client.reannounce_manifest.side_effect = lambda: order.append("manifest")
    announcer = MeshAnnouncer(rtc_client)

    await announcer._announce_once()

    rtc_client.refresh_presence.assert_awaited_once_with()
    rtc_client.reannounce_manifest.assert_awaited_once_with()
    assert order == ["presence", "manifest"]


@pytest.mark.asyncio
async def test_presence_refresh_failure_does_not_skip_connected_peer_manifest() -> None:
    rtc_client = AsyncMock()
    rtc_client.refresh_presence.side_effect = RuntimeError("broker unavailable")
    announcer = MeshAnnouncer(rtc_client)

    await announcer._announce_once()

    rtc_client.refresh_presence.assert_awaited_once_with()
    rtc_client.reannounce_manifest.assert_awaited_once_with()
