"""Regression tests for durable local mesh identity persistence."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.services.auth.auth_manager import AuthManager
from app.services.auth.service import AuthService
from app.shared.contracts.models.mesh import MeshIdentitySaveRequest


@pytest.mark.asyncio
async def test_save_mesh_identity_requires_exact_durable_read_back() -> None:
    manager = AuthManager(bus=AsyncMock())
    manager._db_request = AsyncMock(
        side_effect=[
            {"rows": [], "rowcount": 1},
            {
                "rows": [{"peer_id": "stable-peer", "node_name": "Aurora One"}],
                "rowcount": 1,
            },
        ]
    )

    assert await manager.save_mesh_identity("stable-peer", "Aurora One") is True
    assert manager._db_request.await_count == 2


@pytest.mark.asyncio
async def test_save_mesh_identity_rejects_failed_write_without_read_back() -> None:
    manager = AuthManager(bus=AsyncMock())
    manager._db_request = AsyncMock(return_value={"rows": [], "rowcount": 0})

    assert await manager.save_mesh_identity("stable-peer", "Aurora One") is False
    manager._db_request.assert_awaited_once()


@pytest.mark.asyncio
async def test_save_mesh_identity_rejects_mismatched_read_back() -> None:
    manager = AuthManager(bus=AsyncMock())
    manager._db_request = AsyncMock(
        side_effect=[
            {"rows": [], "rowcount": 1},
            {
                "rows": [{"peer_id": "other-peer", "node_name": "Aurora One"}],
                "rowcount": 1,
            },
        ]
    )

    assert await manager.save_mesh_identity("stable-peer", "Aurora One") is False


@pytest.mark.asyncio
async def test_load_mesh_identity_distinguishes_db_failure_from_empty_first_run() -> None:
    manager = AuthManager(bus=AsyncMock())
    manager._db_request = AsyncMock(return_value=None)

    with pytest.raises(RuntimeError, match="load mesh identity"):
        await manager.load_mesh_identity()


@pytest.mark.asyncio
async def test_load_mesh_identity_allows_successful_empty_first_run() -> None:
    manager = AuthManager(bus=AsyncMock())
    manager._db_request = AsyncMock(return_value={"rows": [], "rowcount": 0})

    assert await manager.load_mesh_identity() == {"peer_id": None, "node_name": ""}


@pytest.mark.asyncio
async def test_save_mesh_identity_service_reports_durable_result() -> None:
    service = AuthService()
    service._manager = SimpleNamespace(save_mesh_identity=AsyncMock(return_value=False))

    response = await service.handle_save_mesh_identity(
        MeshIdentitySaveRequest(peer_id="stable-peer", node_name="Aurora One")
    )

    assert response.success is False
    service.manager.save_mesh_identity.assert_awaited_once_with(
        peer_id="stable-peer",
        node_name="Aurora One",
    )
