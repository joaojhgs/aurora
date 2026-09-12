"""Security regressions for mesh reconnect and fresh-session credentials."""

from __future__ import annotations

import hashlib
import hmac
import json
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.services.auth.auth_manager import AuthManager
from app.services.auth.service import AuthService
from app.shared.auth.identity import Identity
from app.shared.contracts.models.auth import (
    MeshPairingTokenValidationRequest,
    MeshReconnectProofRequest,
    build_mesh_reconnect_proof_message,
)
from app.shared.models.db import Token

TOKEN_ID = "token-row-1"
RAW_TOKEN = "remote-bearer-secret"
TOKEN_HASH = hashlib.sha256(RAW_TOKEN.encode()).hexdigest()
CHALLENGE = "a" * 64
CHANNEL_BINDING = "b" * 64
SESSION_ID = "c" * 64
CLAIMANT = "stable-peer-a"
VERIFIER = "stable-peer-b"
ROOM = "private-mesh-room"


def _fixture_reconnect() -> dict:
    return json.loads(Path("tests/fixtures/webrtc_web_thin_protocol_vectors.json").read_text())[
        "reconnect"
    ]


def _fixture_token() -> Token:
    reconnect = _fixture_reconnect()
    return Token(
        id=reconnect["inputs"]["token_id"],
        token_hash=reconnect["inputs"]["raw_token_sha256_hex"],
        prefix="synthetic",
        device_id="device-a",
        user_id="user-a",
        scopes=["Gateway.use"],
        expires_at=datetime.now() + timedelta(days=1),
    )


def _token(*, expired: bool = False) -> Token:
    return Token(
        id=TOKEN_ID,
        token_hash=TOKEN_HASH,
        prefix=RAW_TOKEN[:8],
        device_id="device-a",
        user_id="user-a",
        scopes=["Gateway.use"],
        expires_at=datetime.now() + (timedelta(seconds=-1) if expired else timedelta(days=1)),
    )


def _identity(source: str) -> Identity:
    return Identity(
        principal_id="user-a",
        principal_name="Aurora A",
        permissions=frozenset({"Gateway.use"}),
        effective_perms=frozenset({"Gateway.use"}),
        device_id="device-a",
        source=source,
    )


def _proof(**overrides: str) -> str:
    fields = {
        "token_id": TOKEN_ID,
        "challenge": CHALLENGE,
        "channel_binding": CHANNEL_BINDING,
        "claimant_peer_id": CLAIMANT,
        "verifier_peer_id": VERIFIER,
        "room_name": ROOM,
    }
    fields.update(overrides)
    message = build_mesh_reconnect_proof_message(**fields)
    return hmac.digest(bytes.fromhex(TOKEN_HASH), message, "sha256").hex()


def test_reconnect_proof_message_has_stable_domain_separated_vector() -> None:
    message = build_mesh_reconnect_proof_message(
        token_id=TOKEN_ID,
        challenge=CHALLENGE,
        channel_binding=CHANNEL_BINDING,
        claimant_peer_id=CLAIMANT,
        verifier_peer_id=VERIFIER,
        room_name=ROOM,
    )

    assert hashlib.sha256(message).hexdigest() == (
        "a99c4295fc0dbd7b871980252575aadd28617e190a12bdecd2564b3cca97fd98"
    )


def test_reconnect_proof_message_uses_ensure_ascii_for_unicode_identities() -> None:
    message = build_mesh_reconnect_proof_message(
        token_id="token-é",
        challenge="a" * 64,
        channel_binding="b" * 64,
        claimant_peer_id="peer-😀",
        verifier_peer_id="peer-β",
        room_name="café/</room",
    )

    assert message == (
        b"aurora.mesh.reconnect-proof.v1\x00"
        b'{"challenge":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",'
        b'"channel_binding":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",'
        b'"claimant_peer_id":"peer-\\ud83d\\ude00",'
        b'"room_name":"caf\\u00e9/</room",'
        b'"token_id":"token-\\u00e9",'
        b'"verifier_peer_id":"peer-\\u03b2",'
        b'"version":1}'
    )
    assert (
        hmac.digest(hashlib.sha256("tökén😀".encode()).digest(), message, "sha256").hex()
        == "23192dbc7bc20cbecad7683032bc064b9cb6c4bca37a6ef2572a2f737c014f22"
    )


def _manager() -> AuthManager:
    manager = AuthManager(bus=AsyncMock())
    manager.load_mesh_identity = AsyncMock(
        return_value={"peer_id": VERIFIER, "node_name": "Aurora B"}
    )
    manager._get_token_by_id = AsyncMock(return_value=_token())
    manager._mesh_outbound_credential_is_linked = AsyncMock(return_value=True)
    manager.build_identity_from_token = AsyncMock(return_value=_identity("webrtc_reconnect_proof"))
    manager._revoke_token = AsyncMock(return_value=True)
    return manager


@pytest.mark.asyncio
async def test_reconnect_proof_accepts_shared_web_thin_protocol_vector() -> None:
    reconnect = _fixture_reconnect()
    manager = _manager()
    manager.load_mesh_identity.return_value = {
        "peer_id": reconnect["inputs"]["verifier_peer_id"],
        "node_name": "Aurora verifier",
    }
    manager._get_token_by_id.return_value = _fixture_token()

    identity = await manager.verify_mesh_reconnect_proof(
        token_id=reconnect["inputs"]["token_id"],
        challenge=reconnect["inputs"]["challenge"],
        proof=reconnect["hmac_sha256_hex"],
        channel_binding=reconnect["inputs"]["channel_binding"],
        claimant_peer_id=reconnect["inputs"]["claimant_peer_id"],
        verifier_peer_id=reconnect["inputs"]["verifier_peer_id"],
        room_name=reconnect["inputs"]["room_name"],
    )

    assert identity == _identity("webrtc_reconnect_proof")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("mutation", "expected_link_check"),
    [
        ({"challenge": "c" * 64}, True),
        ({"channel_binding": "d" * 64}, True),
        ({"claimant_peer_id": "wrong-claimant"}, True),
        ({"verifier_peer_id": "wrong-verifier"}, False),
        ({"room_name": "wrong-room"}, True),
    ],
)
async def test_reconnect_proof_rejects_replayed_or_rebound_shared_vectors(
    mutation: dict[str, str], expected_link_check: bool
) -> None:
    reconnect = _fixture_reconnect()
    manager = _manager()
    manager.load_mesh_identity.return_value = {
        "peer_id": reconnect["inputs"]["verifier_peer_id"],
        "node_name": "Aurora verifier",
    }
    manager._get_token_by_id.return_value = _fixture_token()
    arguments = {
        "token_id": reconnect["inputs"]["token_id"],
        "challenge": reconnect["inputs"]["challenge"],
        "proof": reconnect["hmac_sha256_hex"],
        "channel_binding": reconnect["inputs"]["channel_binding"],
        "claimant_peer_id": reconnect["inputs"]["claimant_peer_id"],
        "verifier_peer_id": reconnect["inputs"]["verifier_peer_id"],
        "room_name": reconnect["inputs"]["room_name"],
    }
    arguments.update(mutation)

    assert await manager.verify_mesh_reconnect_proof(**arguments) is None
    if expected_link_check:
        manager._mesh_outbound_credential_is_linked.assert_awaited_once()
    else:
        manager._mesh_outbound_credential_is_linked.assert_not_awaited()


@pytest.mark.asyncio
async def test_reconnect_proof_deleted_or_revoked_token_fails_closed_before_identity_resolution() -> (
    None
):
    reconnect = _fixture_reconnect()
    manager = _manager()
    manager.load_mesh_identity.return_value = {
        "peer_id": reconnect["inputs"]["verifier_peer_id"],
        "node_name": "Aurora verifier",
    }
    manager._get_token_by_id.return_value = None

    assert (
        await manager.verify_mesh_reconnect_proof(
            token_id=reconnect["inputs"]["token_id"],
            challenge=reconnect["inputs"]["challenge"],
            proof=reconnect["hmac_sha256_hex"],
            channel_binding=reconnect["inputs"]["channel_binding"],
            claimant_peer_id=reconnect["inputs"]["claimant_peer_id"],
            verifier_peer_id=reconnect["inputs"]["verifier_peer_id"],
            room_name=reconnect["inputs"]["room_name"],
        )
        is None
    )
    manager._mesh_outbound_credential_is_linked.assert_not_awaited()
    manager.build_identity_from_token.assert_not_awaited()


@pytest.mark.asyncio
async def test_reconnect_proof_resolves_identity_without_returning_secret_material() -> None:
    manager = _manager()

    identity = await manager.verify_mesh_reconnect_proof(
        token_id=TOKEN_ID,
        challenge=CHALLENGE,
        proof=_proof(),
        channel_binding=CHANNEL_BINDING,
        claimant_peer_id=CLAIMANT,
        verifier_peer_id=VERIFIER,
        room_name=ROOM,
    )

    assert identity == _identity("webrtc_reconnect_proof")
    manager._mesh_outbound_credential_is_linked.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("changed_field", "changed_value"),
    [
        ("challenge", "d" * 64),
        ("channel_binding", "e" * 64),
        ("claimant_peer_id", "other-peer"),
        ("room_name", "other-room"),
    ],
)
async def test_reconnect_proof_cannot_move_between_transcripts(
    changed_field: str, changed_value: str
) -> None:
    manager = _manager()
    arguments = {
        "token_id": TOKEN_ID,
        "challenge": CHALLENGE,
        "proof": _proof(),
        "channel_binding": CHANNEL_BINDING,
        "claimant_peer_id": CLAIMANT,
        "verifier_peer_id": VERIFIER,
        "room_name": ROOM,
    }
    arguments[changed_field] = changed_value

    assert await manager.verify_mesh_reconnect_proof(**arguments) is None


@pytest.mark.asyncio
async def test_reconnect_proof_requires_exact_mesh_token_ownership() -> None:
    manager = _manager()
    manager._mesh_outbound_credential_is_linked.return_value = False

    result = await manager.verify_mesh_reconnect_proof(
        token_id=TOKEN_ID,
        challenge=CHALLENGE,
        proof=_proof(),
        channel_binding=CHANNEL_BINDING,
        claimant_peer_id=CLAIMANT,
        verifier_peer_id=VERIFIER,
        room_name=ROOM,
    )

    assert result is None
    manager.build_identity_from_token.assert_not_awaited()


@pytest.mark.asyncio
async def test_mesh_token_ownership_query_binds_peer_room_and_auth_graph() -> None:
    manager = AuthManager(bus=AsyncMock())
    manager._db_request = AsyncMock(return_value={"rows": [{"id": "row-1"}], "rowcount": 1})
    token = _token()

    assert (
        await manager._mesh_outbound_credential_is_linked(
            token=token,
            claimant_peer_id=CLAIMANT,
            room_name=ROOM,
        )
        is True
    )
    query = manager._db_request.await_args.args[1]
    assert "outbound_status = 'approved'" in query.sql
    assert query.params == [
        CLAIMANT,
        ROOM,
        TOKEN_ID,
        token.device_id,
        token.user_id,
    ]


@pytest.mark.asyncio
async def test_reconnect_proof_revokes_expired_token_before_identity_resolution() -> None:
    manager = _manager()
    manager._get_token_by_id.return_value = _token(expired=True)

    result = await manager.verify_mesh_reconnect_proof(
        token_id=TOKEN_ID,
        challenge=CHALLENGE,
        proof=_proof(),
        channel_binding=CHANNEL_BINDING,
        claimant_peer_id=CLAIMANT,
        verifier_peer_id=VERIFIER,
        room_name=ROOM,
    )

    assert result is None
    manager._revoke_token.assert_awaited_once_with(TOKEN_ID)
    manager._mesh_outbound_credential_is_linked.assert_not_awaited()


@pytest.mark.asyncio
async def test_fresh_pairing_token_must_match_exact_exchanged_session() -> None:
    manager = _manager()
    manager.pairing_requests = {
        "opaque-handle": {
            "status": "exchanged",
            "pairing_session_id": SESSION_ID,
            "remote_peer_id": CLAIMANT,
            "room_name": ROOM,
            "exchange_result": {"token_id": TOKEN_ID, "token": RAW_TOKEN},
        }
    }
    manager.build_identity_from_token.return_value = _identity("webrtc_pairing_session")

    accepted = await manager.validate_mesh_pairing_token(
        token_str=RAW_TOKEN,
        pairing_session_id=SESSION_ID,
        claimant_peer_id=CLAIMANT,
        room_name=ROOM,
    )
    rejected_old = await manager.validate_mesh_pairing_token(
        token_str="older-valid-bearer",
        pairing_session_id=SESSION_ID,
        claimant_peer_id=CLAIMANT,
        room_name=ROOM,
    )

    assert accepted == _identity("webrtc_pairing_session")
    assert rejected_old is None


@pytest.mark.asyncio
async def test_auth_contracts_return_identity_only_for_both_mesh_validators() -> None:
    service = AuthService()
    service._manager = SimpleNamespace(
        verify_mesh_reconnect_proof=AsyncMock(return_value=_identity("webrtc_reconnect_proof")),
        validate_mesh_pairing_token=AsyncMock(return_value=_identity("webrtc_pairing_session")),
    )

    reconnect = await service.handle_verify_mesh_reconnect_proof(
        MeshReconnectProofRequest(
            token_id=TOKEN_ID,
            challenge=CHALLENGE,
            proof=_proof(),
            channel_binding=CHANNEL_BINDING,
            claimant_peer_id=CLAIMANT,
            verifier_peer_id=VERIFIER,
            room_name=ROOM,
        )
    )
    fresh = await service.handle_validate_mesh_pairing_token(
        MeshPairingTokenValidationRequest(
            token=RAW_TOKEN,
            pairing_session_id=SESSION_ID,
            claimant_peer_id=CLAIMANT,
            room_name=ROOM,
        )
    )

    assert reconnect.valid is True
    assert fresh.valid is True
    assert "token" not in reconnect.model_dump()
    assert "token_hash" not in reconnect.model_dump()
    assert "token" not in fresh.model_dump()
    assert "token_hash" not in fresh.model_dump()
