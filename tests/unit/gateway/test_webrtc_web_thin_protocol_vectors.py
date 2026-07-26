from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from app.services.gateway.utils import crypto as gateway_crypto
from app.services.gateway.webrtc.pairing_sas import (
    PairingSASHandshake,
    derive_channel_binding,
    pairing_identity,
)
from app.services.gateway.webrtc.protocol_contract import protocol_descriptor
from app.services.gateway.webrtc.signaling.mqtt_client import MQTTSignaling
from app.shared.contracts.models.auth import build_mesh_reconnect_proof_message
from scripts.generate_webrtc_protocol_fixtures import build_fixture

FIXTURE_PATH = Path("tests/fixtures/webrtc_web_thin_protocol_vectors.json")


def _fixture() -> dict:
    return json.loads(FIXTURE_PATH.read_text())


@pytest.mark.unit
def test_webrtc_web_thin_protocol_fixture_is_regenerated_byte_for_byte() -> None:
    expected = (
        json.dumps(build_fixture(), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n"
    )
    assert FIXTURE_PATH.read_text() == expected


@pytest.mark.unit
def test_protocol_descriptor_matches_fixture_and_reserves_future_features() -> None:
    fixture = _fixture()
    descriptor = protocol_descriptor()

    assert fixture["protocol_descriptor"] == descriptor
    assert descriptor["protocol_version"] == 1
    assert descriptor["pairing_protocol_version"] == 2
    assert descriptor["data_channel_label"] == "aurora-rpc"
    assert descriptor["capabilities"]["rpc"]["fragmentation"] is True
    assert descriptor["capabilities"]["rpc"]["backpressure"] is True
    assert descriptor["capabilities"]["rpc"]["scoped_event_subscriptions"] is True
    assert descriptor["capabilities"]["rpc"]["consumer_only_peer"] is True


@pytest.mark.unit
def test_current_crypto_helpers_match_room_vectors(monkeypatch: pytest.MonkeyPatch) -> None:
    vector = _fixture()["room_crypto"]
    inputs = vector["inputs"]
    keys = gateway_crypto.derive_room_keys(inputs["password"], inputs["app_id"], inputs["room"])

    assert keys.k0.hex() == vector["k0_hex"]
    assert keys.k_sig.hex() == vector["k_sig_hex"]
    assert keys.k_data.hex() == vector["k_data_hex"]

    nonce = bytes.fromhex(vector["aead"]["nonce_hex"])
    monkeypatch.setattr(
        gateway_crypto.os, "urandom", lambda size: nonce if size == 12 else b"\x00" * size
    )
    plaintext = json.loads(vector["aead"]["plaintext_compact_json"])
    payload = gateway_crypto.aead_seal(keys.k_sig, plaintext)
    assert payload.hex() == vector["aead"]["payload_hex"]
    assert gateway_crypto.aead_open(keys.k_sig, payload) == vector["aead"]["plaintext"]


@pytest.mark.unit
def test_current_mqtt_topic_shapes_match_vectors() -> None:
    signaling = MQTTSignaling([], app_id="aurora-fixture", room="lab-room", peer_id="peer-offer")
    topics = _fixture()["signaling"]["topics"]

    assert signaling._topic("presence/peer-offer") == topics["presence_peer"]  # noqa: SLF001
    assert signaling._topic("presence/+") == topics["presence_wildcard"]  # noqa: SLF001
    assert signaling._topic("offer", "peer-offer") == topics["offer_to_peer"]  # noqa: SLF001
    assert signaling._topic("answer", "peer-offer") == topics["answer_to_peer"]  # noqa: SLF001
    assert signaling._topic("candidate", "peer-offer") == topics["candidate_to_peer"]  # noqa: SLF001
    assert signaling._topic("broadcast") == topics["broadcast"]  # noqa: SLF001


@pytest.mark.unit
def test_pairing_and_reconnect_helpers_match_vectors() -> None:
    fixture = _fixture()
    pairing = fixture["pairing"]
    inputs = pairing["inputs"]
    channel_binding = derive_channel_binding(
        app_id=inputs["app_id"],
        room=inputs["room"],
        offerer_signaling_id=inputs["offerer_signaling_id"],
        answerer_signaling_id=inputs["answerer_signaling_id"],
        offer_sdp=inputs["offer_sdp"],
        answer_sdp=inputs["answer_sdp"],
    )
    assert channel_binding == pairing["channel_binding_sha256"]

    offerer_identity = pairing_identity(
        role="offerer",
        stable_peer_id="stable-offer",
        node_name="Fixture Offerer",
        signaling_peer_id="sig-offer",
    )
    answerer_identity = pairing_identity(
        role="answerer",
        stable_peer_id="stable-answer",
        node_name="Fixture Answerer",
        signaling_peer_id="sig-answer",
    )
    offerer = PairingSASHandshake(
        channel_binding_sha256=channel_binding,
        local_identity=offerer_identity,
        expected_remote_identity=answerer_identity,
        local_nonce=bytes.fromhex(inputs["offerer_nonce_hex"]),
    )
    answerer = PairingSASHandshake(
        channel_binding_sha256=channel_binding,
        local_identity=answerer_identity,
        expected_remote_identity=offerer_identity,
        local_nonce=bytes.fromhex(inputs["answerer_nonce_hex"]),
    )

    assert offerer.commit_message() == pairing["offerer_commit_message"]
    assert answerer.commit_message() == pairing["answerer_commit_message"]
    offerer.accept_commit(answerer.commit_message())
    answerer.accept_commit(offerer.commit_message())
    assert offerer.reveal_message() == pairing["offerer_reveal_message"]
    assert answerer.reveal_message() == pairing["answerer_reveal_message"]
    result = offerer.accept_reveal(answerer.reveal_message())
    assert result.pairing_session_id == pairing["sas"]["pairing_session_id"]
    assert result.verification_code == pairing["sas"]["verification_code"]
    assert result.transcript_sha256 == pairing["sas"]["transcript_sha256"]

    reconnect = fixture["reconnect"]
    reconnect_inputs = dict(reconnect["inputs"])
    reconnect_inputs.pop("raw_token_sha256_hex")
    reconnect_inputs.pop("claimant_signaling_peer_id")
    reconnect_inputs.pop("verifier_signaling_peer_id")
    assert build_mesh_reconnect_proof_message(**reconnect_inputs).hex() == reconnect["message_hex"]

    challenge = reconnect["challenge"]["frame"]
    assert "token_id" not in challenge
    assert challenge == {
        "type": "mesh_auth_challenge_v1",
        "challenge": reconnect["inputs"]["challenge"],
        "channel_binding": reconnect["inputs"]["channel_binding"],
        "claimant_peer_id": reconnect["inputs"]["claimant_peer_id"],
        "verifier_peer_id": reconnect["inputs"]["verifier_peer_id"],
        "claimant_signaling_peer_id": reconnect["inputs"]["claimant_signaling_peer_id"],
        "verifier_signaling_peer_id": reconnect["inputs"]["verifier_signaling_peer_id"],
        "room_name": reconnect["inputs"]["room_name"],
    }
    proof = reconnect["proof"]["frame"]
    assert proof["proof"] == reconnect["hmac_sha256_hex"]
    assert "proof_hmac_sha256" not in proof


@pytest.mark.asyncio
async def test_runtime_peer_bridge_emits_committed_rpc_call_cancel_and_event_vectors() -> None:
    from contextlib import suppress
    from unittest.mock import AsyncMock, MagicMock

    from app.services.gateway.mesh.peer_bridge import PeerBridge

    fixture = _fixture()["rpc_frames"]
    rtc_client = MagicMock()
    rtc_client.send_to_peer = MagicMock(return_value=True)
    rtc_client.send_to_peer_async = AsyncMock(return_value=True)
    bridge = PeerBridge(rtc_client, AsyncMock())

    async def simulate_response() -> None:
        for _ in range(20):
            if ("peer-1", "req-001") in bridge._pending_calls:  # noqa: SLF001
                bridge.on_response(
                    "peer-1", {"type": "result", "id": "req-001", "result": {"ok": True}}
                )
                return
            await asyncio.sleep(0.01)

    task = asyncio.create_task(simulate_response())
    result = await bridge.call(
        "peer-1",
        "Gateway.GetRegistry",
        {"include_internal": False},
        timeout=1.0,
        correlation_id="req-001",
    )
    await task
    assert result.ok is True
    call_wire = rtc_client.send_to_peer_async.call_args_list[0].args[1]
    assert call_wire == fixture["call"]["json"]
    assert json.loads(call_wire) == fixture["call"]["frame"]

    assert await bridge.fire_event_async(
        "peer-1",
        "Tooling.ProjectionInvalidated",
        {"peer_id": "stable-offer"},
        correlation_id="corr-event-001",
    )
    event_wire = rtc_client.send_to_peer_async.call_args_list[-1].args[1]
    assert event_wire == fixture["event"]["json"]
    assert json.loads(event_wire) == fixture["event"]["frame"]

    stream = bridge.stream_call(
        "peer-1",
        "Gateway.GetRegistry",
        {"include_internal": False},
        timeout=5.0,
        correlation_id="stream-002",
    )
    pending = asyncio.create_task(anext(stream))
    await asyncio.sleep(0.05)
    pending.cancel()
    with suppress(asyncio.CancelledError):
        await pending
    cancel_wire = rtc_client.send_to_peer_async.call_args_list[-1].args[1]
    assert cancel_wire == fixture["cancel"]["json"]
    assert json.loads(cancel_wire) == fixture["cancel"]["frame"]


@pytest.mark.unit
def test_runtime_rpc_handler_send_helpers_emit_committed_frame_vectors() -> None:
    from unittest.mock import AsyncMock, MagicMock

    from app.services.gateway.webrtc.rpc import RPCHandler

    fixture = _fixture()["rpc_frames"]
    sent: list[str] = []
    handler = RPCHandler(AsyncMock(), AsyncMock(), sent.append, MagicMock())

    handler._send_chunk("stream-001", {"delta": "hello"})  # noqa: SLF001
    handler._send_error(  # noqa: SLF001
        "req-002",
        401,
        "Authentication required",
        correlation_id="corr-002",
    )

    assert sent[0] == fixture["chunk"]["json"]
    assert json.loads(sent[0]) == fixture["chunk"]["frame"]
    assert sent[1] == fixture["error"]["json"]
    assert json.loads(sent[1]) == fixture["error"]["frame"]


@pytest.mark.asyncio
async def test_runtime_rpc_handler_peer_protocol_frames_match_committed_vectors() -> None:
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from app.services.gateway.acl.identity import Identity
    from app.services.gateway.webrtc.event_subscriptions import MeshEventSubscriptionRegistry
    from app.services.gateway.webrtc.peer_protocol import CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1
    from app.services.gateway.webrtc.rpc import RPCHandler
    from app.shared.contracts.models.gateway import MethodInfo

    fixture = _fixture()["peer_protocol"]
    identity = Identity(
        principal_id="peer-stable-answer",
        principal_name="Fixture Answerer",
        effective_perms=frozenset({"*"}),
        source="webrtc_peer",
    )

    subscribe_sent: list[str] = []
    subscribe_handler = RPCHandler(
        AsyncMock(),
        AsyncMock(),
        subscribe_sent.append,
        lambda: identity,
        stable_peer_id_provider=lambda: "stable-answer",
        authenticated_peer_validator=lambda: True,
        event_subscription_registry=MeshEventSubscriptionRegistry(clock=lambda: 1000.0),
        peer_supports_capability=lambda capability: capability == CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1,
        event_topic_authorizer=lambda _peer_id, topic, _identity: topic
        == "Tooling.ProjectionInvalidated",
    )
    await subscribe_handler.on_message(fixture["subscriptions"]["subscribe"]["json"])

    assert subscribe_sent == [fixture["subscriptions"]["subscribed"]["json"]]
    assert json.loads(subscribe_sent[0]) == fixture["subscriptions"]["subscribed"]["frame"]

    consumer_sent: list[str] = []
    registry = AsyncMock()
    registry.get_service = AsyncMock(
        return_value=SimpleNamespace(
            methods=[
                MethodInfo(
                    name="GetRegistry",
                    bus_topic="Gateway.GetRegistry",
                    exposure="external",
                    required_perms=[],
                )
            ]
        )
    )
    consumer_handler = RPCHandler(
        AsyncMock(),
        registry,
        consumer_sent.append,
        lambda: identity,
        local_peer_role_provider=lambda: "consumer",
    )
    await consumer_handler.on_message(fixture["consumer_only"]["call"]["json"])

    assert consumer_sent == [fixture["consumer_only"]["error"]["json"]]
    assert json.loads(consumer_sent[0]) == fixture["consumer_only"]["error"]["frame"]
