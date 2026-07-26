"""Regression tests for durable SAS-bound mesh pairing denials."""

from datetime import datetime, timedelta
from unittest.mock import AsyncMock

import pytest

from app.services.auth.auth_manager import AuthManager, MeshPairingDeniedError
from app.shared.contracts.models.db import (
    DBDenyMeshPeerRequest,
    DBMethods,
    DBRemoveMeshPeerRequest,
)


def _pending_mesh_request() -> dict[str, object]:
    return {
        "id": "request-one",
        "device_name": "Aurora Two",
        "client_ip": "unknown",
        "rate_limit_key": "webrtc:transport-two",
        "status": "pending",
        "created_at": datetime.now(),
        "expires_at": datetime.now() + timedelta(minutes=5),
        "approved_by": None,
        "remote_peer_id": "stable-peer-two",
        "remote_node_name": "Aurora Two",
        "room_name": "private-room",
        "pairing_session_id": "a" * 64,
        "verification_code": "48271935",
    }


@pytest.mark.asyncio
async def test_pairing_deny_persists_exact_peer_and_room_before_memory_state() -> None:
    manager = AuthManager(bus=AsyncMock())
    manager.pairing_requests["opaque-handle"] = _pending_mesh_request()
    manager._db_request = AsyncMock(return_value={"success": True, "authority_changes": []})

    assert await manager.deny_pairing("opaque-handle", "admin-one") is True

    request = manager.pairing_requests["opaque-handle"]
    assert request["status"] == "denied"
    topic, db_request = manager._db_request.await_args.args
    assert topic == DBMethods.DENY_MESH_PEER
    assert db_request == DBDenyMeshPeerRequest(
        peer_id="stable-peer-two",
        room_name="private-room",
    )


@pytest.mark.asyncio
async def test_pairing_deny_does_not_mutate_memory_when_persistence_fails() -> None:
    manager = AuthManager(bus=AsyncMock())
    manager.pairing_requests["opaque-handle"] = _pending_mesh_request()
    manager._db_request = AsyncMock(return_value={"success": False})

    assert await manager.deny_pairing("opaque-handle", "admin-one") is False
    assert manager.pairing_requests["opaque-handle"]["status"] == "pending"
    manager.bus.publish.assert_not_awaited()


@pytest.mark.asyncio
async def test_automatic_pairing_start_refuses_durably_denied_peer() -> None:
    manager = AuthManager(bus=AsyncMock())
    manager._db_request = AsyncMock(
        return_value={
            "rows": [
                {
                    "peer_id": "stable-peer-two",
                    "room_name": "private-room",
                    "outbound_status": "denied",
                }
            ],
            "rowcount": 1,
        }
    )

    code = await manager.start_pairing(
        "Aurora Two",
        "unknown",
        remote_peer_id="stable-peer-two",
        remote_node_name="Aurora Two",
        room_name="private-room",
        pairing_session_id="b" * 64,
        verification_code="48271935",
        trusted_rate_limit_key="webrtc:transport-two",
    )

    assert code is None
    assert manager.pairing_requests == {}
    manager.bus.publish.assert_not_awaited()


@pytest.mark.asyncio
async def test_mesh_rpc_pairing_start_reports_durable_denial_explicitly() -> None:
    manager = AuthManager(bus=AsyncMock())
    manager._db_request = AsyncMock(
        return_value={
            "rows": [
                {
                    "peer_id": "stable-peer-two",
                    "room_name": "private-room",
                    "outbound_status": "denied",
                }
            ],
            "rowcount": 1,
        }
    )

    with pytest.raises(MeshPairingDeniedError):
        await manager.start_pairing(
            "Aurora Two",
            "unknown",
            remote_peer_id="stable-peer-two",
            remote_node_name="Aurora Two",
            room_name="private-room",
            pairing_session_id="d" * 64,
            verification_code="48271935",
            trusted_rate_limit_key="webrtc:transport-two",
            raise_on_denied=True,
        )


@pytest.mark.asyncio
async def test_admin_peer_removal_is_existing_explicit_denial_clear_path() -> None:
    manager = AuthManager(bus=AsyncMock())
    denied = True

    async def db_request(topic, request, **_kwargs):
        nonlocal denied
        if topic == DBMethods.REMOVE_MESH_PEER:
            assert request == DBRemoveMeshPeerRequest(
                peer_id="stable-peer-two",
                revoke_token=True,
            )
            denied = False
            return {"success": True, "authority_changes": []}
        if request.sql.startswith("SELECT * FROM mesh_peers"):
            rows = (
                [
                    {
                        "peer_id": "stable-peer-two",
                        "room_name": "private-room",
                        "outbound_status": "denied",
                    }
                ]
                if denied
                else []
            )
            return {"rows": rows, "rowcount": len(rows)}
        if request.sql.startswith("INSERT INTO mesh_peers"):
            return {"rows": [], "rowcount": 1}
        raise AssertionError(f"Unexpected SQL: {request.sql}")

    manager._db_request = AsyncMock(side_effect=db_request)
    pairing_args = {
        "device_name": "Aurora Two",
        "client_ip": "unknown",
        "remote_peer_id": "stable-peer-two",
        "remote_node_name": "Aurora Two",
        "room_name": "private-room",
        "verification_code": "48271935",
        "trusted_rate_limit_key": "webrtc:transport-two",
    }

    session_id = "c" * 64
    assert await manager.start_pairing(pairing_session_id=session_id, **pairing_args) is None

    manager.pairing_requests["old-denied-handle"] = _pending_mesh_request()
    manager.pairing_requests["old-denied-handle"]["status"] = "denied"
    manager.pairing_requests["old-denied-handle"]["pairing_session_id"] = session_id
    manager.pairing_attempts["webrtc:transport-two"] = 1

    assert await manager.remove_mesh_peer("stable-peer-two") is True
    assert "old-denied-handle" not in manager.pairing_requests
    assert "webrtc:transport-two" not in manager.pairing_attempts
    assert await manager.start_pairing(pairing_session_id=session_id, **pairing_args)
