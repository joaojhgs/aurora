"""Regression tests for fail-closed Gateway mesh identity startup."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, PropertyMock, patch

import pytest

from app.messaging.bus import QueryResult
from app.services.gateway.config import Settings
from app.services.gateway.service import GatewayService
from app.shared.contracts.models.auth import AuthMethods

pytest.importorskip("aiortc", reason="Gateway WebRTC tests require aiortc")


@pytest.mark.asyncio
async def test_get_or_create_peer_id_persists_normal_first_run_identity() -> None:
    service = GatewayService()
    service._bus = AsyncMock()

    async def request(method, payload, **_kwargs):
        if method == AuthMethods.LOAD_MESH_IDENTITY:
            return QueryResult(ok=True, data={"peer_id": None, "node_name": ""})
        assert method == AuthMethods.SAVE_MESH_IDENTITY
        assert payload.peer_id.startswith("aurora-")
        return QueryResult(ok=True, data={"success": True})

    service._bus.request.side_effect = request

    with patch.object(
        GatewayService,
        "bus",
        new_callable=PropertyMock,
        return_value=service._bus,
    ):
        peer_id = await service._get_or_create_peer_id(SimpleNamespace(node_name="Aurora One"))

    assert peer_id.startswith("aurora-")
    assert service._bus.request.await_count == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "responses",
    [
        [QueryResult(ok=False, error="database unavailable")],
        [
            QueryResult(ok=True, data={"peer_id": None, "node_name": ""}),
            QueryResult(ok=True, data={"success": False}),
        ],
    ],
    ids=["load-failure", "save-failure"],
)
async def test_get_or_create_peer_id_never_falls_back_to_ephemeral(
    responses: list[QueryResult],
) -> None:
    service = GatewayService()
    service._bus = AsyncMock()
    service._bus.request.side_effect = responses

    with (
        patch.object(
            GatewayService,
            "bus",
            new_callable=PropertyMock,
            return_value=service._bus,
        ),
        pytest.raises(RuntimeError, match="durable mesh identity"),
    ):
        await service._get_or_create_peer_id(SimpleNamespace(node_name="Aurora One"))


@pytest.mark.asyncio
async def test_start_mesh_does_not_join_when_durable_identity_is_unavailable() -> None:
    service = GatewayService()
    service._bus = AsyncMock()
    rtc_client = MagicMock()
    rtc_client.refresh_presence = AsyncMock()
    rtc_client._adapter = SimpleNamespace(join_room=AsyncMock())
    service._rtc_client = rtc_client

    settings = Settings()
    settings.mesh = settings.mesh.model_copy(update={"enabled": True})
    service._get_gateway_config = AsyncMock(return_value=settings)
    service._wait_for_auth_pairing_service = AsyncMock(return_value=True)
    service._get_or_create_peer_id = AsyncMock(
        side_effect=RuntimeError("durable mesh identity unavailable")
    )

    await service._start_mesh()

    rtc_client.refresh_presence.assert_not_awaited()
    rtc_client._adapter.join_room.assert_not_awaited()
    assert service._mesh_bus is None
    assert service._mesh_peer_id is None
    await service._stop_mesh()
