from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, PropertyMock, patch

import pytest

from app.messaging.bus import Envelope
from app.services.auth.auth_manager import (
    AUTH_DB_REQUEST_TIMEOUT_SECONDS,
    MeshPairingDeniedError,
)
from app.services.auth.service import AuthService
from app.shared.contracts.mesh_surface import PUBLIC_INFRASTRUCTURE_TOPICS
from app.shared.contracts.models.auth import (
    AuthMethods,
    ListPendingPairingsRequest,
    PairingConnectRequest,
    PairingExchangeRequest,
    PairingStartRequest,
    PrincipalListRequest,
    StoreAuditEventRequest,
    TokenCreateRequest,
    TokenListRequest,
)
from app.shared.contracts.models.mesh import MeshPeerGetRequest
from app.shared.models.db import Token, User


@pytest.mark.asyncio
async def test_store_audit_event_waits_through_sqlite_busy_window() -> None:
    service = AuthService()
    bus = AsyncMock()
    bus.request.return_value = SimpleNamespace(ok=True)

    with patch.object(AuthService, "bus", new_callable=PropertyMock, return_value=bus):
        response = await service.handle_store_audit_event(
            StoreAuditEventRequest(event="mesh.reconnect", details="{}")
        )

    assert response.success
    assert bus.request.await_args.kwargs["timeout"] == AUTH_DB_REQUEST_TIMEOUT_SECONDS


def test_auth_public_infrastructure_markers_are_exact_bootstrap_allowlist() -> None:
    marked = {
        metadata["method_id"]
        for _name, member in AuthService.__dict__.items()
        if (metadata := getattr(member, "_contract_metadata", None))
        and metadata.get("public_infrastructure")
    }

    assert marked == set(PUBLIC_INFRASTRUCTURE_TOPICS)
    assert marked == {
        AuthMethods.LOGIN,
        AuthMethods.PAIRING_START,
        AuthMethods.PAIRING_CONNECT,
        AuthMethods.PAIRING_EXCHANGE,
    }


@pytest.mark.asyncio
async def test_pairing_start_uses_transport_peer_for_rate_limit_not_payload_identity() -> None:
    service = AuthService()
    service._manager = SimpleNamespace(start_pairing=AsyncMock(return_value="123456"))
    request = PairingStartRequest(
        device_name="Untrusted request",
        client_ip="spoofed-client-ip",
        remote_peer_id="spoofed-stable-peer",
        remote_node_name="Spoofed node",
    )
    envelope = Envelope(
        type="Auth.PairingStart",
        payload=request,
        origin="external",
        caller_peer_id="transport-peer-id",
    )

    response = await service.handle_pairing_start(request, envelope=envelope)

    assert not isinstance(response, dict)
    assert response.code == "123456"
    service.manager.start_pairing.assert_awaited_once_with(
        "Untrusted request",
        "spoofed-client-ip",
        remote_peer_id="spoofed-stable-peer",
        remote_node_name="Spoofed node",
        room_name="",
        pairing_session_id="",
        verification_code="",
        trusted_rate_limit_key="webrtc:transport-peer-id",
    )


@pytest.mark.asyncio
async def test_pairing_start_round_trips_bilateral_session_metadata() -> None:
    """The opaque request handle stays separate from the display-only SAS."""
    service = AuthService()
    service._manager = SimpleNamespace(
        start_pairing=AsyncMock(return_value="opaque-request-handle")
    )
    pairing_session_id = "a" * 64
    verification_code = "48271935"
    request = PairingStartRequest(
        device_name="Aurora 1",
        remote_peer_id="stable-peer-a",
        remote_node_name="Aurora 1",
        room_name="private-mesh-room",
        pairing_session_id=pairing_session_id,
        verification_code=verification_code,
    )
    envelope = Envelope(
        type="Auth.PairingStart",
        payload=request,
        origin="external",
        identity_source="webrtc_rpc",
        caller_peer_id="transport-peer-a",
    )

    response = await service.handle_pairing_start(request, envelope=envelope)

    assert not isinstance(response, dict)
    assert response.code == "opaque-request-handle"
    assert response.code != verification_code
    assert response.pairing_session_id == pairing_session_id
    assert response.verification_code == verification_code
    service.manager.start_pairing.assert_awaited_once_with(
        "Aurora 1",
        "unknown",
        remote_peer_id="stable-peer-a",
        remote_node_name="Aurora 1",
        room_name="private-mesh-room",
        pairing_session_id=pairing_session_id,
        verification_code=verification_code,
        trusted_rate_limit_key="webrtc:transport-peer-a",
        raise_on_denied=True,
    )


@pytest.mark.asyncio
async def test_pairing_start_returns_terminal_status_for_durably_denied_mesh_peer() -> None:
    service = AuthService()
    service._manager = SimpleNamespace(start_pairing=AsyncMock(side_effect=MeshPairingDeniedError))
    request = PairingStartRequest(
        device_name="Aurora 1",
        remote_peer_id="stable-peer-a",
        remote_node_name="Aurora 1",
        room_name="private-mesh-room",
        pairing_session_id="a" * 64,
        verification_code="48271935",
    )
    envelope = Envelope(
        type="Auth.PairingStart",
        payload=request,
        origin="external",
        identity_source="webrtc_rpc",
        caller_peer_id="transport-peer-a",
    )

    response = await service.handle_pairing_start(request, envelope=envelope)

    assert response == {"error": "Pairing denied", "status": "denied"}


@pytest.mark.asyncio
async def test_pairing_connect_and_pending_queue_preserve_bilateral_metadata() -> None:
    pairing_session_id = "c" * 64
    verification_code = "48271935"
    stored_request = {
        "id": "request-1",
        "request_id": "request-1",
        "code": "opaque-request-handle",
        "device_name": "Aurora 1",
        "client_ip": "unknown",
        "status": "pending",
        "created_at": "2026-07-10T12:00:00Z",
        "expires_at": "2099-01-01T00:00:00Z",
        "remote_peer_id": "stable-peer-a",
        "remote_node_name": "Aurora 1",
        "approved_by": None,
        "denied_by": None,
        "denied_reason": "",
        "granted_permissions": [],
        "granted_is_admin": False,
        "pairing_session_id": pairing_session_id,
        "verification_code": verification_code,
    }
    service = AuthService()
    service._manager = SimpleNamespace(
        connect_pairing=AsyncMock(return_value=stored_request),
        list_pending_pairings=AsyncMock(return_value=([stored_request], 0)),
    )
    service._audit_admin_pairing_queue_list = AsyncMock()

    connected = await service.handle_pairing_connect(
        PairingConnectRequest(code="opaque-request-handle")
    )
    listed = await service.handle_list_pending_pairings(ListPendingPairingsRequest())

    assert not isinstance(connected, dict)
    assert connected.pairing_session_id == pairing_session_id
    assert connected.verification_code == verification_code
    assert listed.pairings[0].pairing_session_id == pairing_session_id
    assert listed.pairings[0].verification_code == verification_code


@pytest.mark.asyncio
async def test_pairing_exchange_preserves_stable_mesh_identity() -> None:
    service = AuthService()
    service._manager = SimpleNamespace(
        exchange_pairing=AsyncMock(
            return_value={
                "token": "issued-token",
                "device_id": "device-1",
                "user_id": "user-1",
                "permissions": ["Gateway.use"],
                "token_id": "token-1",
                "peer_id": "stable-peer-1",
                "node_name": "Aurora Studio",
            }
        )
    )

    response = await service.handle_pairing_exchange(PairingExchangeRequest(code="123456"))

    assert not isinstance(response, dict)
    assert response.peer_id == "stable-peer-1"
    assert response.node_name == "Aurora Studio"
    service.manager.exchange_pairing.assert_awaited_once_with(
        "123456",
        pairing_session_id="",
        trusted_rate_limit_key="pairing:external",
    )


@pytest.mark.asyncio
async def test_auth_list_apis_normalize_permissions_and_token_scopes() -> None:
    service = AuthService()
    listed_token = Token(
        id="tok-list",
        token_hash="hash",
        prefix="pref",
        user_id="user-1",
        scopes=["tts.*"],
        created_at=datetime(2026, 1, 1),
        expires_at=datetime(2026, 2, 1),
    )
    # Simulate a stale local DB row that still stores a JSON string, legacy
    # "all", lower-case prefixes, and duplicate scopes.
    listed_token.scopes = '["tts.*", "all", "tts.*"]'  # type: ignore[assignment]
    created_token = Token(
        id="tok-create",
        token_hash="hash2",
        prefix="pref2",
        user_id="user-1",
        scopes=["config.manage", "all", "config.manage"],
        created_at=datetime(2026, 1, 2),
        expires_at=datetime(2026, 3, 1),
    )
    service._manager = SimpleNamespace(
        list_principals=AsyncMock(
            return_value=[
                User(
                    id="user-1",
                    username="operator",
                    password_hash="hash",
                    permissions=["auth.manage", "all", "auth.manage"],
                    is_admin=True,
                    created_at=datetime(2026, 1, 1),
                )
            ]
        ),
        list_tokens=AsyncMock(return_value=[listed_token]),
        create_token_for_principal=AsyncMock(return_value=(created_token, "raw-token")),
    )

    principals = await service.handle_list_principals(PrincipalListRequest())
    tokens = await service.handle_list_tokens(TokenListRequest())
    created = await service.handle_create_token(
        TokenCreateRequest(principal_id="user-1", scopes=["Config.manage"], expires_in_days=30)
    )

    assert principals.principals[0].permissions == ["Auth.manage", "*"]
    assert tokens.tokens[0].scopes == ["TTS.*", "*"]
    assert not isinstance(created, dict)
    assert created.scopes == ["Config.manage", "*"]
    service.manager.list_principals.assert_awaited_once()
    service.manager.list_tokens.assert_awaited_once_with(principal_id=None, device_id=None)
    service.manager.create_token_for_principal.assert_awaited_once()


@pytest.mark.asyncio
async def test_mesh_get_peer_normalizes_legacy_permission_storage() -> None:
    service = AuthService()
    service._manager = SimpleNamespace(
        get_mesh_peer=AsyncMock(
            return_value={
                "id": "mesh-row-1",
                "peer_id": "aurora-peer-1",
                "node_name": "Aurora phone",
                "room_name": "private-room",
                "outbound_permissions": '["tooling.use", "all", "tooling.use"]',
                "inbound_permissions": '["orchestrator.use"]',
            }
        )
    )

    response = await service.handle_get_peer(
        MeshPeerGetRequest(peer_id="aurora-peer-1", room_name="private-room")
    )

    assert response.peer is not None
    assert response.peer.outbound_permissions == ["Tooling.use", "*"]
    assert response.peer.inbound_permissions == ["Orchestrator.use"]
    service.manager.get_mesh_peer.assert_awaited_once_with(
        peer_id="aurora-peer-1",
        room_name="private-room",
    )
