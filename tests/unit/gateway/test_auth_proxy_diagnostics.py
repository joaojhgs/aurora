from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from app.messaging.bus import QueryResult
from app.services.gateway.auth_proxy import (
    AUTH_SERVICE_REQUEST_TIMEOUT_SECONDS,
    BusAuthProxy,
)
from app.shared.contracts.models.auth import (
    AuthMethods,
    MeshReconnectProofResponse,
)

_RECONNECT_ARGUMENTS = {
    "token_id": "public-token-id",
    "challenge": "11" * 32,
    "proof": "22" * 32,
    "channel_binding": "33" * 32,
    "claimant_peer_id": "remote-stable-peer",
    "verifier_peer_id": "local-stable-peer",
    "room_name": "private-room",
}


@pytest.mark.asyncio
async def test_transport_audit_waits_for_persistence_result() -> None:
    bus = AsyncMock()
    bus.request.return_value = QueryResult(ok=True, data={"ok": True})
    proxy = BusAuthProxy(bus)

    await proxy.db_manager.store_audit_event(
        event="mesh.reconnect",
        principal_id="peer-safe-id",
        details="{}",
    )

    bus.request.assert_awaited_once()
    assert bus.request.await_args.args[0] == AuthMethods.STORE_AUDIT_EVENT
    assert bus.request.await_args.kwargs["timeout"] == AUTH_SERVICE_REQUEST_TIMEOUT_SECONDS
    bus.publish.assert_not_awaited()


@pytest.mark.asyncio
async def test_transport_audit_reports_failed_persistence_without_leaking_details() -> None:
    bus = AsyncMock()
    bus.request.return_value = QueryResult(ok=False, error="raw-secret-token private-room")
    proxy = BusAuthProxy(bus)

    with patch("app.services.gateway.auth_proxy.log_warning") as mock_warning:
        await proxy.db_manager.store_audit_event(
            event="mesh.reconnect",
            principal_id="peer-safe-id",
            details="raw-secret-token private-room",
        )

    message = mock_warning.call_args.args[0]
    assert "RuntimeError" in message
    assert "raw-secret-token" not in message
    assert "private-room" not in message


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


@pytest.mark.asyncio
async def test_reconnect_proof_bus_failure_is_retryable_and_redacted() -> None:
    """A transport timeout must not be mistaken for an invalid credential."""

    bus = AsyncMock()
    bus.request.return_value = QueryResult(
        ok=False,
        error="Request timeout containing private-room and raw-secret-token",
    )
    proxy = BusAuthProxy(bus)

    with (
        patch("app.services.gateway.auth_proxy.log_warning") as mock_warning,
        pytest.raises(RuntimeError, match="request was unavailable"),
    ):
        await proxy.verify_mesh_reconnect_proof(**_RECONNECT_ARGUMENTS)

    message = mock_warning.call_args.args[0]
    assert "result=retry" in message
    assert "reason=RuntimeError" in message
    assert "raw-secret-token" not in message
    assert "private-room" not in message
    assert bus.request.await_args.args[0] == AuthMethods.VERIFY_MESH_RECONNECT_PROOF
    assert bus.request.await_args.kwargs["timeout"] == AUTH_SERVICE_REQUEST_TIMEOUT_SECONDS


@pytest.mark.asyncio
async def test_reconnect_proof_explicit_rejection_remains_terminal() -> None:
    """A successful Auth response with valid=false is a real proof rejection."""

    bus = AsyncMock()
    bus.request.return_value = QueryResult(
        ok=True,
        data=MeshReconnectProofResponse(valid=False).model_dump(),
    )
    proxy = BusAuthProxy(bus)

    token = await proxy.verify_mesh_reconnect_proof(**_RECONNECT_ARGUMENTS)

    assert token is None
