from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from app.messaging.bus import QueryResult
from app.services.gateway.auth_proxy import BusAuthProxy
from app.shared.contracts.models.auth import AuthMethods


@pytest.mark.asyncio
async def test_save_mesh_credential_exception_fails_closed_with_redacted_diagnostic() -> None:
    bus = AsyncMock()
    bus.request.side_effect = RuntimeError("raw-secret-token private-room")
    proxy = BusAuthProxy(bus)

    with patch("app.services.gateway.auth_proxy.log_warning") as mock_warning:
        saved = await proxy.save_mesh_credential(room_name="private-room", token="raw-secret-token")

    assert saved is False
    message = mock_warning.call_args.args[0]
    assert "result=fail_closed" in message
    assert "reason=RuntimeError" in message
    assert "raw-secret-token" not in message
    assert "private-room" not in message
    assert bus.request.await_args.args[0] == AuthMethods.SAVE_MESH_CREDENTIAL


@pytest.mark.asyncio
async def test_load_mesh_credential_exception_fails_closed_with_redacted_diagnostic() -> None:
    bus = AsyncMock()
    bus.request.side_effect = RuntimeError("raw-secret-token private-room")
    proxy = BusAuthProxy(bus)

    with patch("app.services.gateway.auth_proxy.log_warning") as mock_warning:
        token = await proxy.load_mesh_credential("private-room")

    assert token is None
    message = mock_warning.call_args.args[0]
    assert "result=fail_closed" in message
    assert "reason=RuntimeError" in message
    assert "raw-secret-token" not in message
    assert "private-room" not in message
    assert bus.request.await_args.args[0] == AuthMethods.LOAD_MESH_CREDENTIAL


@pytest.mark.asyncio
async def test_mesh_credential_missing_auth_is_not_success() -> None:
    bus = AsyncMock()
    bus.request.return_value = QueryResult(ok=False, error="Auth unavailable")
    proxy = BusAuthProxy(bus)

    saved = await proxy.save_mesh_credential(room_name="private-room", token="raw-secret-token")
    token = await proxy.load_mesh_credential("private-room")

    assert saved is False
    assert token is None
