"""Regression tests for transactional Gateway mesh bootstrap."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, PropertyMock, call, patch

import pytest

from app.messaging.bus import QueryResult
from app.services.gateway.config import Settings
from app.services.gateway.service import GatewayService, _MeshStartOutcome

pytest.importorskip("aiortc", reason="Gateway WebRTC tests require aiortc")


def _started_component() -> MagicMock:
    component = MagicMock()
    component.start = AsyncMock()
    component.stop = AsyncMock()
    return component


def _peer_bridge() -> MagicMock:
    bridge = MagicMock()
    bridge.cancel_all = AsyncMock()
    return bridge


def _rtc_client() -> MagicMock:
    rtc_client = MagicMock()
    rtc_client.refresh_presence = AsyncMock()
    rtc_client._adapter = SimpleNamespace(leave=AsyncMock())
    return rtc_client


@pytest.mark.asyncio
async def test_credential_load_failure_keeps_presence_deferred_and_cleans_components() -> None:
    service = GatewayService()
    inner_bus = AsyncMock()
    rtc_client = _rtc_client()
    service._rtc_client = rtc_client

    settings = Settings()
    settings.mesh = settings.mesh.model_copy(update={"enabled": True})
    service._get_gateway_config = AsyncMock(return_value=settings)
    service._wait_for_auth_pairing_service = AsyncMock(return_value=True)
    service._get_or_create_peer_id = AsyncMock(return_value="stable-peer-id")
    service._load_mesh_inbound_credentials = AsyncMock(
        side_effect=RuntimeError("database unavailable")
    )

    peer_registry = _started_component()
    latency_monitor = _started_component()
    peer_bridge = _peer_bridge()

    with (
        patch.object(
            GatewayService,
            "bus",
            new_callable=PropertyMock,
            return_value=inner_bus,
        ),
        patch(
            "app.services.gateway.mesh.peer_registry.PeerRegistry",
            return_value=peer_registry,
        ),
        patch(
            "app.services.gateway.mesh.routing_table.RoutingTable",
            return_value=MagicMock(),
        ),
        patch(
            "app.services.gateway.mesh.peer_bridge.PeerBridge",
            return_value=peer_bridge,
        ),
        patch(
            "app.services.gateway.mesh.latency.LatencyMonitor",
            return_value=latency_monitor,
        ),
    ):
        await service._start_mesh()

    rtc_client.refresh_presence.assert_not_awaited()
    rtc_client._adapter.leave.assert_not_awaited()
    peer_registry.stop.assert_awaited_once()
    latency_monitor.stop.assert_awaited_once()
    peer_bridge.cancel_all.assert_awaited_once()
    assert service._mesh_bus is None
    assert service._mesh_peer_registry is None
    assert service._mesh_routing_table is None
    assert service._mesh_peer_bridge is None
    assert service._mesh_latency_monitor is None
    assert service._mesh_announcer is None
    assert service._mesh_peer_id is None
    await service._stop_mesh()
    assert service._mesh_start_retry_task is None


@pytest.mark.asyncio
async def test_presence_failure_self_recovers_without_config_change_or_restart() -> None:
    service = GatewayService()
    inner_bus = AsyncMock()
    inner_bus.request.return_value = QueryResult(ok=True, data={"authorities": []})
    rtc_client = _rtc_client()
    rtc_client.refresh_presence.side_effect = [RuntimeError("presence publish failed"), None]
    service._rtc_client = rtc_client

    settings = Settings()
    settings.mesh = settings.mesh.model_copy(update={"enabled": True})
    service._get_gateway_config = AsyncMock(return_value=settings)
    service._wait_for_auth_pairing_service = AsyncMock(return_value=True)
    service._get_or_create_peer_id = AsyncMock(return_value="stable-peer-id")
    service._load_mesh_inbound_credentials = AsyncMock(return_value=None)

    registries = [_started_component(), _started_component()]
    latency_monitors = [_started_component(), _started_component()]
    announcers = [_started_component(), _started_component()]
    bridges = [_peer_bridge(), _peer_bridge()]
    mesh_buses = [MagicMock(_inner=inner_bus), MagicMock(_inner=inner_bus)]
    announcers[0].stop.side_effect = RuntimeError("announcer cleanup failed")

    with (
        patch.object(
            GatewayService,
            "bus",
            new_callable=PropertyMock,
            return_value=inner_bus,
        ),
        patch(
            "app.services.gateway.mesh.peer_registry.PeerRegistry",
            side_effect=registries,
        ),
        patch(
            "app.services.gateway.mesh.routing_table.RoutingTable",
            side_effect=[MagicMock(), MagicMock()],
        ),
        patch(
            "app.services.gateway.mesh.peer_bridge.PeerBridge",
            side_effect=bridges,
        ),
        patch(
            "app.services.gateway.mesh.latency.LatencyMonitor",
            side_effect=latency_monitors,
        ),
        patch(
            "app.services.gateway.mesh.announcer.MeshAnnouncer",
            side_effect=announcers,
        ),
        patch("app.messaging.mesh_bus.MeshBus", side_effect=mesh_buses),
        patch("app.messaging.bus_runtime.set_bus") as set_runtime_bus,
        patch("app.shared.messaging.bus_init.set_bus") as set_shared_bus,
        patch("app.services.gateway.service._MESH_START_RETRY_INITIAL_DELAY_S", 0.001),
        patch("app.services.gateway.service._MESH_START_RETRY_MAX_DELAY_S", 0.002),
    ):
        await service._start_mesh()

        assert service._mesh_bus is None
        rtc_client._adapter.leave.assert_awaited_once()
        registries[0].stop.assert_awaited_once()
        latency_monitors[0].stop.assert_awaited_once()
        announcers[0].stop.assert_awaited_once()
        bridges[0].cancel_all.assert_awaited_once()

        async with asyncio.timeout(1.0):
            while service._mesh_bus is None:
                await asyncio.sleep(0.001)

    assert service._mesh_bus is mesh_buses[1]
    assert service._mesh_peer_registry is registries[1]
    assert service._mesh_peer_bridge is bridges[1]
    assert service._mesh_latency_monitor is latency_monitors[1]
    assert service._mesh_announcer is announcers[1]
    assert service._mesh_peer_id == "stable-peer-id"
    assert rtc_client.refresh_presence.await_count == 2
    assert service._mesh_start_retry_task is None
    registries[1].start.assert_awaited_once()
    latency_monitors[1].start.assert_awaited_once()
    announcers[1].start.assert_awaited_once()
    set_runtime_bus.assert_has_calls([call(mesh_buses[0]), call(inner_bus), call(mesh_buses[1])])
    set_shared_bus.assert_has_calls([call(mesh_buses[0]), call(inner_bus), call(mesh_buses[1])])
    assert rtc_client.set_rpc_bus.call_args_list == [
        call(mesh_buses[0]),
        call(inner_bus),
        call(mesh_buses[1]),
    ]


@pytest.mark.asyncio
async def test_mesh_start_retry_is_deduplicated_serialized_and_cancelled_on_disable() -> None:
    service = GatewayService()
    active_attempts = 0
    max_active_attempts = 0

    async def fail_transiently() -> _MeshStartOutcome:
        nonlocal active_attempts, max_active_attempts
        active_attempts += 1
        max_active_attempts = max(max_active_attempts, active_attempts)
        await asyncio.sleep(0.001)
        active_attempts -= 1
        return _MeshStartOutcome.RETRY

    service._start_mesh_once = AsyncMock(side_effect=fail_transiently)

    await asyncio.gather(service._start_mesh(), service._start_mesh())

    retry_task = service._mesh_start_retry_task
    assert retry_task is not None
    assert max_active_attempts == 1

    settings = Settings()
    settings.mesh = settings.mesh.model_copy(update={"enabled": False})
    service._get_gateway_config = AsyncMock(return_value=settings)
    await service._reload_mesh_config()

    assert service._mesh_start_retry_task is None
    assert retry_task.cancelled()


@pytest.mark.asyncio
async def test_failed_rtc_start_is_closed_then_background_retry_starts_rtc_and_mesh() -> None:
    service = GatewayService()
    inner_bus = AsyncMock()
    inner_bus.request.return_value = QueryResult(ok=True, data={"authorities": []})

    settings = Settings()
    settings.mesh = settings.mesh.model_copy(update={"enabled": True})
    settings.webrtc.enabled = True
    service._get_gateway_config = AsyncMock(return_value=settings)
    service._ensure_mesh_prerequisites = AsyncMock(return_value=True)
    service._wait_for_auth_pairing_service = AsyncMock(return_value=True)
    service._get_or_create_peer_id = AsyncMock(return_value="stable-peer-id")
    service._load_mesh_inbound_credentials = AsyncMock(return_value=None)

    registry_aggregator = AsyncMock()
    service._registry_aggregator = registry_aggregator

    failed_rtc = _rtc_client()
    failed_rtc.start = AsyncMock(side_effect=RuntimeError("mqtt unavailable"))
    failed_rtc.close = AsyncMock()
    recovered_rtc = _rtc_client()
    recovered_rtc.start = AsyncMock()
    recovered_rtc.close = AsyncMock()

    peer_registry = _started_component()
    latency_monitor = _started_component()
    announcer = _started_component()
    peer_bridge = _peer_bridge()
    mesh_bus = MagicMock(_inner=inner_bus)

    with (
        patch.object(
            GatewayService,
            "bus",
            new_callable=PropertyMock,
            return_value=inner_bus,
        ),
        patch(
            "app.services.gateway.webrtc.rtc_client.RTCClient",
            side_effect=[failed_rtc, recovered_rtc],
        ) as rtc_client_class,
        patch("app.services.gateway.dependencies.set_rtc_client") as set_rtc_client,
        patch(
            "app.services.gateway.mesh.peer_registry.PeerRegistry",
            return_value=peer_registry,
        ),
        patch(
            "app.services.gateway.mesh.routing_table.RoutingTable",
            return_value=MagicMock(),
        ),
        patch(
            "app.services.gateway.mesh.peer_bridge.PeerBridge",
            return_value=peer_bridge,
        ),
        patch(
            "app.services.gateway.mesh.latency.LatencyMonitor",
            return_value=latency_monitor,
        ),
        patch(
            "app.services.gateway.mesh.announcer.MeshAnnouncer",
            return_value=announcer,
        ),
        patch("app.messaging.mesh_bus.MeshBus", return_value=mesh_bus),
        patch("app.messaging.bus_runtime.set_bus"),
        patch("app.shared.messaging.bus_init.set_bus"),
        patch("app.services.gateway.service._MESH_START_RETRY_INITIAL_DELAY_S", 0.001),
        patch("app.services.gateway.service._MESH_START_RETRY_MAX_DELAY_S", 0.002),
    ):
        assert await service._start_webrtc(settings) is False
        assert service._rtc_client is None
        failed_rtc.close.assert_awaited_once()

        assert await service._start_mesh() is _MeshStartOutcome.RETRY

        async with asyncio.timeout(1.0):
            while service._mesh_bus is None:
                await asyncio.sleep(0.001)

    assert rtc_client_class.call_count == 2
    recovered_rtc.start.assert_awaited_once_with(join_room=False)
    recovered_rtc.refresh_presence.assert_awaited_once()
    set_rtc_client.assert_called_once_with(recovered_rtc)
    assert service._rtc_client is recovered_rtc
    assert service._mesh_bus is mesh_bus
    assert service._mesh_start_retry_task is None


@pytest.mark.asyncio
async def test_stopping_mesh_during_rtc_retry_closes_partial_client() -> None:
    service = GatewayService()
    inner_bus = AsyncMock()

    settings = Settings()
    settings.mesh = settings.mesh.model_copy(update={"enabled": True})
    settings.webrtc.enabled = True
    service._get_gateway_config = AsyncMock(return_value=settings)
    service._ensure_mesh_prerequisites = AsyncMock(return_value=True)
    service._registry_aggregator = AsyncMock()

    rtc_start_entered = asyncio.Event()

    async def block_rtc_start(*, join_room: bool) -> None:
        assert join_room is False
        rtc_start_entered.set()
        await asyncio.Future()

    partial_rtc = _rtc_client()
    partial_rtc.start = AsyncMock(side_effect=block_rtc_start)
    partial_rtc.close = AsyncMock()

    with (
        patch.object(
            GatewayService,
            "bus",
            new_callable=PropertyMock,
            return_value=inner_bus,
        ),
        patch(
            "app.services.gateway.webrtc.rtc_client.RTCClient",
            return_value=partial_rtc,
        ),
        patch("app.services.gateway.dependencies.set_rtc_client") as set_rtc_client,
        patch("app.services.gateway.service._MESH_START_RETRY_INITIAL_DELAY_S", 0.001),
        patch("app.services.gateway.service._MESH_START_RETRY_MAX_DELAY_S", 0.002),
    ):
        assert await service._start_mesh() is _MeshStartOutcome.RETRY
        retry_task = service._mesh_start_retry_task
        assert retry_task is not None

        async with asyncio.timeout(1.0):
            await rtc_start_entered.wait()

        await service._stop_mesh()

    partial_rtc.close.assert_awaited_once()
    set_rtc_client.assert_not_called()
    assert service._rtc_client is None
    assert service._mesh_start_retry_task is None
    assert retry_task.cancelled()
