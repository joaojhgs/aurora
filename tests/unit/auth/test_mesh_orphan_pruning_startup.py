"""Auth-owned startup maintenance for orphaned mesh peer rows."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, PropertyMock, patch

import pytest

from app.services.auth.auth_manager import AUTH_DB_REQUEST_TIMEOUT_SECONDS
from app.services.auth.service import AuthService
from app.shared.contracts.models.db import DBMethods


class _FakeConfigAPI:
    def __init__(self, auth_config: SimpleNamespace):
        self._auth_config = auth_config
        self.aget = AsyncMock(return_value=auth_config)


def _auth_config(
    *,
    enabled: bool = True,
    retention_seconds: int = 7200,
    max_rows: int = 17,
    permissions: list[str] | None = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        default_pairing_permissions=permissions or [],
        mesh_peer_orphan_pruning_enabled=enabled,
        mesh_peer_orphan_retention_seconds=retention_seconds,
        mesh_peer_orphan_prune_max_rows=max_rows,
    )


async def _start_auth_with_config(
    auth_config: SimpleNamespace,
    *,
    bus_request_result: object | None = None,
    bus_request_side_effect: Exception | None = None,
) -> tuple[AuthService, AsyncMock, MagicMock, _FakeConfigAPI]:
    bus = AsyncMock()
    if bus_request_side_effect is not None:
        bus.request.side_effect = bus_request_side_effect
    else:
        bus.request.return_value = (
            bus_request_result
            if bus_request_result is not None
            else SimpleNamespace(ok=True, data={"success": True, "pruned_rows": []})
        )
    manager = MagicMock()
    manager.initialize = AsyncMock()
    manager.update_permission_defaults = MagicMock()
    config = _FakeConfigAPI(auth_config)

    service = AuthService()
    with (
        patch("app.shared.config.interface.ConfigAPI", return_value=config),
        patch("app.services.auth.service.AuthManager", return_value=manager),
        patch.object(type(service), "bus", new_callable=PropertyMock, return_value=bus),
    ):
        await service.on_start()

    return service, bus, manager, config


@pytest.mark.asyncio
async def test_auth_startup_prunes_orphaned_mesh_peer_rows_with_configured_bounds() -> None:
    service, bus, manager, config = await _start_auth_with_config(
        _auth_config(retention_seconds=9000, max_rows=23, permissions=["TTS.Request"]),
        bus_request_result=SimpleNamespace(
            ok=True,
            data={
                "success": True,
                "pruned_rows": [
                    {
                        "row_id": "row-1",
                        "peer_id": "peer-1",
                        "room_name": "room-1",
                    }
                ],
            },
        ),
    )

    bus.request.assert_awaited_once()
    topic, request = bus.request.await_args.args
    assert topic == DBMethods.PRUNE_ORPHANED_MESH_PEER_ROWS
    assert request.retention_seconds == 9000
    assert request.max_rows == 23
    assert bus.request.await_args.kwargs["timeout"] == AUTH_DB_REQUEST_TIMEOUT_SECONDS
    manager.initialize.assert_awaited_once()
    manager.update_permission_defaults.assert_called_once_with(["TTS.Request"])
    config.aget.assert_awaited_once()
    assert service._mesh_peer_orphan_pruning_enabled is True


@pytest.mark.asyncio
async def test_auth_startup_skips_orphan_pruning_when_disabled() -> None:
    _service, bus, manager, _config = await _start_auth_with_config(
        _auth_config(enabled=False),
    )

    bus.request.assert_not_awaited()
    manager.initialize.assert_awaited_once()


@pytest.mark.asyncio
async def test_auth_startup_orphan_pruning_failure_does_not_break_startup() -> None:
    service, bus, manager, _config = await _start_auth_with_config(
        _auth_config(),
        bus_request_side_effect=RuntimeError("database busy"),
    )

    bus.request.assert_awaited_once()
    manager.initialize.assert_awaited_once()
    assert service.manager is manager


@pytest.mark.asyncio
async def test_auth_reload_updates_orphan_pruning_settings() -> None:
    config = _FakeConfigAPI(
        _auth_config(
            enabled=False,
            retention_seconds=3600,
            max_rows=3,
            permissions=["Config.manage"],
        )
    )
    service = AuthService()
    service._manager = SimpleNamespace(
        invalidate_mesh_inbound_key_cache=MagicMock(),
        update_permission_defaults=MagicMock(),
    )

    with patch("app.shared.config.interface.ConfigAPI", return_value=config):
        await service.reload("services.auth")

    assert service._mesh_peer_orphan_pruning_enabled is False
    assert service._mesh_peer_orphan_retention_seconds == 3600
    assert service._mesh_peer_orphan_prune_max_rows == 3
    service._manager.invalidate_mesh_inbound_key_cache.assert_called_once_with()
    service._manager.update_permission_defaults.assert_called_once_with(["Config.manage"])
