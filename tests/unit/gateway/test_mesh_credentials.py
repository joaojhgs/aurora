"""Regression tests for canonical peer-scoped mesh credential handling."""

from unittest.mock import AsyncMock, MagicMock, PropertyMock, patch

import pytest

from app.messaging.bus import QueryResult
from app.services.gateway.service import GatewayService
from app.shared.contracts.models.auth import AuthMethods


@pytest.mark.asyncio
async def test_empty_peer_credentials_require_pairing_without_legacy_room_lookup():
    service = GatewayService()
    service._bus = AsyncMock()
    service._bus.request.return_value = {"credentials": {}}
    service._rtc_client = MagicMock()

    with patch.object(
        GatewayService,
        "bus",
        new_callable=PropertyMock,
        return_value=service._bus,
    ):
        await service._load_mesh_inbound_credentials("private-room")

    service._bus.request.assert_awaited_once()
    assert service._bus.request.await_args.args[0] == AuthMethods.MESH_LOAD_INBOUND_CREDENTIALS
    service._rtc_client.set_saved_peer_tokens.assert_not_called()
    service._rtc_client.set_saved_auth_token.assert_not_called()


@pytest.mark.asyncio
async def test_peer_credentials_load_as_peer_keyed_tokens_only():
    service = GatewayService()
    service._bus = AsyncMock()
    credentials = {
        "peer-one": {"token": "token-one", "token_id": "token-id-one"},
        "peer-two": {"token": "token-two", "token_id": "token-id-two"},
    }
    service._bus.request.return_value = {"credentials": credentials}
    service._rtc_client = MagicMock()

    with patch.object(
        GatewayService,
        "bus",
        new_callable=PropertyMock,
        return_value=service._bus,
    ):
        await service._load_mesh_inbound_credentials("private-room")

    service._bus.request.assert_awaited_once()
    assert service._bus.request.await_args.args[0] == AuthMethods.MESH_LOAD_INBOUND_CREDENTIALS
    service._rtc_client.set_saved_peer_tokens.assert_called_once_with(credentials)
    service._rtc_client.set_saved_auth_token.assert_not_called()


@pytest.mark.asyncio
async def test_peer_credential_load_propagates_auth_storage_failure():
    service = GatewayService()
    service._bus = AsyncMock()
    service._bus.request.return_value = QueryResult(ok=False, error="database unavailable")
    service._rtc_client = MagicMock()

    with (
        patch.object(
            GatewayService,
            "bus",
            new_callable=PropertyMock,
            return_value=service._bus,
        ),
        pytest.raises(RuntimeError, match="Could not load mesh credentials"),
    ):
        await service._load_mesh_inbound_credentials("private-room")

    service._rtc_client.set_saved_peer_tokens.assert_not_called()


@pytest.mark.asyncio
async def test_pairing_token_persists_only_with_remote_peer_identity():
    service = GatewayService()
    bus = AsyncMock()
    bus.request.return_value = QueryResult(ok=True, data={"success": True})

    await service._persist_mesh_inbound_credential(
        bus=bus,
        room_name="private-room",
        token="private-token",
        token_id="private-token-id",
        remote_peer_id="peer-one",
        remote_device_id="device-one",
        remote_user_id="user-one",
        remote_node_name="Peer one",
        permissions=["Gateway.use"],
    )

    assert bus.request.await_count == 2
    topics = [call.args[0] for call in bus.request.await_args_list]
    assert topics == [
        AuthMethods.MESH_UPSERT_PEER,
        AuthMethods.MESH_SAVE_INBOUND_CREDENTIAL,
    ]
    save_request = bus.request.await_args_list[1].args[1]
    assert save_request.token_id == "private-token-id"

    bus.reset_mock()
    with pytest.raises(ValueError, match="remote peer"):
        await service._persist_mesh_inbound_credential(
            bus=bus,
            room_name="private-room",
            token="private-token",
            token_id="private-token-id",
            remote_peer_id=None,
        )

    bus.request.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("failed_call", ["upsert", "save"])
async def test_pairing_token_persistence_requires_both_durable_writes(
    failed_call: str,
) -> None:
    service = GatewayService()
    bus = AsyncMock()
    success = QueryResult(ok=True, data={"success": True})
    failure = QueryResult(ok=True, data={"success": False, "message": "db write failed"})
    bus.request.side_effect = [failure] if failed_call == "upsert" else [success, failure]

    with pytest.raises(RuntimeError, match="persist mesh pairing token"):
        await service._persist_mesh_inbound_credential(
            bus=bus,
            room_name="private-room",
            token="private-token",
            token_id="private-token-id",
            remote_peer_id="peer-one",
        )

    assert bus.request.await_count == (1 if failed_call == "upsert" else 2)
