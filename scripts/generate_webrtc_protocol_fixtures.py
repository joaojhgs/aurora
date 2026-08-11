#!/usr/bin/env python3
"""Generate/check deterministic WebRTC WebView thin-shell protocol vectors.

These vectors are synthetic and contain no real credentials.  They pin the
current Python implementation so future TypeScript/WebView WebRTC code can be
validated without importing Python at runtime.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import sys
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.services.gateway.utils.crypto import derive_room_keys  # noqa: E402
from app.services.gateway.webrtc.pairing_sas import (  # noqa: E402
    PAIRING_COMMIT_TYPE,
    PAIRING_REVEAL_TYPE,
    PAIRING_TERMINAL_TYPE,
    PairingSASHandshake,
    derive_channel_binding,
    pairing_identity,
)
from app.services.gateway.webrtc.peer_protocol import (  # noqa: E402
    CAP_BACKPRESSURE_V1,
    CAP_CONSUMER_ONLY_V1,
    CAP_FRAGMENTATION_V1,
    CAP_PROVIDER_LEASE_V1,
    CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1,
    PeerProtocolLimits,
    build_protocol_hello,
    fragment_message,
    negotiate_protocol,
)
from app.services.gateway.webrtc.protocol_contract import protocol_descriptor  # noqa: E402
from app.services.gateway.webrtc.signaling.mqtt_client import MQTTSignaling  # noqa: E402
from app.shared.contracts.models.auth import build_mesh_reconnect_proof_message  # noqa: E402

FIXTURE_PATH = ROOT / "tests" / "fixtures" / "webrtc_web_thin_protocol_vectors.json"


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _compact_json(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"))


def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _topic(channel: str, to_peer: str | None = None) -> str:
    signaling = MQTTSignaling([], app_id="aurora-fixture", room="lab-room", peer_id="peer-offer")
    return signaling._topic(channel, to_peer)  # noqa: SLF001 - intentional contract fixture


def _room_crypto_vectors() -> dict[str, Any]:
    password = "synthetic-fixture-password"
    app_id = "aurora-fixture"
    room = "lab-room"
    plaintext = {
        "type": "presence",
        "app_id": app_id,
        "room": room,
        "peer_id": "peer-offer",
        "node_name": "Fixture Offerer",
    }
    nonce = bytes.fromhex("000102030405060708090a0b")
    keys = derive_room_keys(password, app_id, room)
    ciphertext = AESGCM(keys.k_sig).encrypt(
        nonce,
        _compact_json(plaintext).encode("utf-8"),
        None,
    )
    return {
        "inputs": {"password": password, "app_id": app_id, "room": room},
        "salt_sha256_hex": hashlib.sha256(f"{app_id}|{room}".encode()).hexdigest(),
        "k0_hex": keys.k0.hex(),
        "k_sig_hex": keys.k_sig.hex(),
        "k_data_hex": keys.k_data.hex(),
        "aead": {
            "nonce_hex": nonce.hex(),
            "plaintext": plaintext,
            "plaintext_compact_json": _compact_json(plaintext),
            "payload_hex": (nonce + ciphertext).hex(),
            "payload_base64url": _b64url(nonce + ciphertext),
        },
    }


def _pairing_vectors() -> dict[str, Any]:
    app_id = "aurora-fixture"
    room = "lab-room"
    offer_sdp = (
        "v=0\r\n"
        "o=- 1111111111111111111 2 IN IP4 127.0.0.1\r\n"
        "s=-\r\n"
        "a=fingerprint:sha-256 AA:BB:CC:DD\r\n"
    )
    answer_sdp = (
        "v=0\r\n"
        "o=- 2222222222222222222 2 IN IP4 127.0.0.1\r\n"
        "s=-\r\n"
        "a=fingerprint:sha-256 11:22:33:44\r\n"
    )
    channel_binding = derive_channel_binding(
        app_id=app_id,
        room=room,
        offerer_signaling_id="sig-offer",
        answerer_signaling_id="sig-answer",
        offer_sdp=offer_sdp,
        answer_sdp=answer_sdp,
    )
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
        local_nonce=bytes.fromhex("00" * 32),
    )
    answerer = PairingSASHandshake(
        channel_binding_sha256=channel_binding,
        local_identity=answerer_identity,
        expected_remote_identity=offerer_identity,
        local_nonce=bytes.fromhex("11" * 32),
    )
    offerer_commit = offerer.commit_message()
    answerer_commit = answerer.commit_message()
    offerer.accept_commit(answerer_commit)
    answerer.accept_commit(offerer_commit)
    offerer_reveal = offerer.reveal_message()
    answerer_reveal = answerer.reveal_message()
    offerer_sas = offerer.accept_reveal(answerer_reveal)
    answerer_sas = answerer.accept_reveal(offerer_reveal)
    terminal = {
        "type": PAIRING_TERMINAL_TYPE,
        "status": "denied",
        "pairing_session_id": offerer_sas.pairing_session_id,
        "verification_code": offerer_sas.verification_code,
        "peer_id": "stable-offer",
        "signaling_peer_id": "sig-offer",
    }
    return {
        "inputs": {
            "app_id": app_id,
            "room": room,
            "offerer_signaling_id": "sig-offer",
            "answerer_signaling_id": "sig-answer",
            "offer_sdp": offer_sdp,
            "answer_sdp": answer_sdp,
            "offerer_nonce_hex": "00" * 32,
            "answerer_nonce_hex": "11" * 32,
        },
        "message_types": {
            "commit": PAIRING_COMMIT_TYPE,
            "reveal": PAIRING_REVEAL_TYPE,
            "terminal": PAIRING_TERMINAL_TYPE,
        },
        "channel_binding_sha256": channel_binding,
        "offerer_identity": offerer_identity,
        "answerer_identity": answerer_identity,
        "offerer_commit_message": offerer_commit,
        "answerer_commit_message": answerer_commit,
        "offerer_reveal_message": offerer_reveal,
        "answerer_reveal_message": answerer_reveal,
        "sas": {
            "pairing_session_id": offerer_sas.pairing_session_id,
            "verification_code": offerer_sas.verification_code,
            "transcript_sha256": offerer_sas.transcript_sha256,
            "answerer_view_matches": answerer_sas.verification_code
            == offerer_sas.verification_code,
        },
        "terminal_message": terminal,
    }


def _reconnect_vector() -> dict[str, Any]:
    proof_inputs = {
        "token_id": "token-fixture-001",
        "challenge": "a" * 64,
        "channel_binding": "b" * 64,
        "claimant_peer_id": "stable-answer",
        "verifier_peer_id": "stable-offer",
        "room_name": "lab-room",
    }
    signaling = {
        "claimant_signaling_peer_id": "sig-answer",
        "verifier_signaling_peer_id": "sig-offer",
    }
    token = "synthetic-reconnect-token"
    key = hashlib.sha256(token.encode("utf-8")).digest()
    message = build_mesh_reconnect_proof_message(**proof_inputs)
    proof = hmac.new(key, message, hashlib.sha256).hexdigest()
    challenge_frame = {
        "type": "mesh_auth_challenge_v1",
        "challenge": proof_inputs["challenge"],
        "channel_binding": proof_inputs["channel_binding"],
        "claimant_peer_id": proof_inputs["claimant_peer_id"],
        "verifier_peer_id": proof_inputs["verifier_peer_id"],
        **signaling,
        "room_name": proof_inputs["room_name"],
    }
    proof_frame = {
        "type": "mesh_auth_proof_v1",
        "token_id": proof_inputs["token_id"],
        "challenge": proof_inputs["challenge"],
        "proof": proof,
        "channel_binding": proof_inputs["channel_binding"],
        "claimant_peer_id": proof_inputs["claimant_peer_id"],
        "verifier_peer_id": proof_inputs["verifier_peer_id"],
        **signaling,
        "room_name": proof_inputs["room_name"],
    }
    return {
        "inputs": {**proof_inputs, **signaling, "raw_token_sha256_hex": key.hex()},
        "challenge": {"frame": challenge_frame, "json": _compact_json(challenge_frame)},
        "proof": {"frame": proof_frame, "json": _compact_json(proof_frame)},
        "message_hex": message.hex(),
        "message_utf8_suffix": message.split(b"\x00", 1)[1].decode("utf-8"),
        "hmac_sha256_hex": proof,
    }


def _rpc_vectors() -> dict[str, Any]:
    call = {
        "type": "call",
        "id": "req-001",
        "correlation_id": "req-001",
        "method": "Gateway.GetRegistry",
        "params": {"include_internal": False},
        "identity": {
            "principal_id": None,
            "effective_perms": None,
            "source": None,
            "method_type": None,
            "caller_peer_id": None,
            "auth_grant_revision": None,
            "manifest_revision": None,
        },
    }
    result = {"type": "result", "id": "req-001", "result": {"ok": True}}
    error = {
        "type": "error",
        "id": "req-002",
        "correlation_id": "corr-002",
        "error": {"code": 401, "message": "Authentication required"},
    }
    chunk = {"type": "chunk", "id": "stream-001", "data": {"delta": "hello"}}
    eof = {"type": "eof", "id": "stream-001"}
    cancelled_eof = {"type": "eof", "id": "stream-002", "cancelled": True}
    cancel = {"type": "cancel", "id": "stream-002"}
    event = {
        "type": "event",
        "topic": "Tooling.ProjectionInvalidated",
        "params": {"peer_id": "stable-offer"},
        "correlation_id": "corr-event-001",
    }
    frames = {
        "call": call,
        "result": result,
        "error": error,
        "chunk": chunk,
        "eof": eof,
        "cancelled_eof": cancelled_eof,
        "cancel": cancel,
        "event": event,
    }
    return {name: {"frame": frame, "json": json.dumps(frame)} for name, frame in frames.items()}


def _provider_lease_number_vectors() -> dict[str, Any]:
    canonical_lease = {
        "type": "provider_lease",
        "peer_id": "peer-a",
        "connection_epoch": "epoch-1",
        "availability_revision": 1,
        "issued_at_ms": 1000,
        "expires_at_ms": 61000,
        "available": True,
    }
    canonical_unavailable = {
        "type": "provider_unavailable",
        "peer_id": "peer-a",
        "connection_epoch": "epoch-1",
        "availability_revision": 2,
        "issued_at_ms": 61000,
        "expires_at_ms": 61000,
        "available": False,
        "reason_code": "page_hidden",
    }
    max_safe_integer = (2**53) - 1
    max_safe_unavailable = {
        "type": "provider_unavailable",
        "peer_id": "peer-a",
        "connection_epoch": "epoch-max-safe",
        "availability_revision": max_safe_integer,
        "issued_at_ms": max_safe_integer,
        "expires_at_ms": max_safe_integer,
        "available": False,
        "reason_code": "max_safe_boundary",
    }
    return {
        "capability": CAP_PROVIDER_LEASE_V1,
        "accepted": [
            {
                "name": "canonical_integer_provider_lease",
                "canonical_json": True,
                "frame": canonical_lease,
                "json": _canonical_json(canonical_lease),
            },
            {
                "name": "integral_decimal_provider_lease",
                "canonical_json": False,
                "frame": canonical_lease,
                "json": (
                    '{"availability_revision":1.0,"available":true,'
                    '"connection_epoch":"epoch-1","expires_at_ms":61000.0,'
                    '"issued_at_ms":1000.0,"peer_id":"peer-a","type":"provider_lease"}'
                ),
            },
            {
                "name": "safe_exponent_provider_lease",
                "canonical_json": False,
                "frame": canonical_lease,
                "json": (
                    '{"availability_revision":1,"available":true,'
                    '"connection_epoch":"epoch-1","expires_at_ms":61e3,'
                    '"issued_at_ms":1e3,"peer_id":"peer-a","type":"provider_lease"}'
                ),
            },
            {
                "name": "canonical_integer_provider_unavailable",
                "canonical_json": True,
                "frame": canonical_unavailable,
                "json": _canonical_json(canonical_unavailable),
            },
            {
                "name": "max_safe_integer_provider_unavailable",
                "canonical_json": True,
                "frame": max_safe_unavailable,
                "json": _canonical_json(max_safe_unavailable),
            },
        ],
        "rejected": [
            {
                "name": "fractional_revision_provider_lease",
                "error_fragment": "integer",
                "json": (
                    '{"availability_revision":1.5,"available":true,'
                    '"connection_epoch":"epoch-1","expires_at_ms":61000,'
                    '"issued_at_ms":1000,"peer_id":"peer-a","type":"provider_lease"}'
                ),
            },
            {
                "name": "boolean_revision_provider_lease",
                "error_fragment": "integer",
                "json": (
                    '{"availability_revision":true,"available":true,'
                    '"connection_epoch":"epoch-1","expires_at_ms":61000,'
                    '"issued_at_ms":1000,"peer_id":"peer-a","type":"provider_lease"}'
                ),
            },
            {
                "name": "negative_revision_provider_unavailable",
                "error_fragment": "integer",
                "json": (
                    '{"availability_revision":-1,"available":false,'
                    '"connection_epoch":"epoch-1","expires_at_ms":61000,'
                    '"issued_at_ms":1000,"peer_id":"peer-a",'
                    '"reason_code":"negative_revision","type":"provider_unavailable"}'
                ),
            },
            {
                "name": "unsafe_revision_provider_unavailable",
                "error_fragment": "integer",
                "json": (
                    '{"availability_revision":9007199254740992,"available":false,'
                    '"connection_epoch":"epoch-1","expires_at_ms":61000,'
                    '"issued_at_ms":1000,"peer_id":"peer-a",'
                    '"reason_code":"unsafe_revision","type":"provider_unavailable"}'
                ),
            },
            {
                "name": "negative_issued_at_provider_unavailable",
                "error_fragment": "integer",
                "json": (
                    '{"availability_revision":3,"available":false,'
                    '"connection_epoch":"epoch-1","expires_at_ms":0,'
                    '"issued_at_ms":-1,"peer_id":"peer-a",'
                    '"reason_code":"negative_issue_time","type":"provider_unavailable"}'
                ),
            },
            {
                "name": "expiry_regression_provider_lease",
                "error_fragment": "expires",
                "json": (
                    '{"availability_revision":1,"available":true,'
                    '"connection_epoch":"epoch-1","expires_at_ms":999,'
                    '"issued_at_ms":1000,"peer_id":"peer-a","type":"provider_lease"}'
                ),
            },
        ],
    }


def _peer_protocol_vectors() -> dict[str, Any]:
    limits = PeerProtocolLimits(
        fragment_payload_bytes=8,
        max_logical_bytes=512,
        max_peer_aggregate_bytes=1024,
        incomplete_ttl_seconds=5.0,
        max_fragments=32,
    )
    local_hello = build_protocol_hello(
        role="hybrid",
        capabilities=(
            CAP_FRAGMENTATION_V1,
            CAP_BACKPRESSURE_V1,
            CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1,
        ),
        limits=limits,
    )
    consumer_hello = build_protocol_hello(
        role="consumer",
        capabilities=(
            CAP_FRAGMENTATION_V1,
            CAP_BACKPRESSURE_V1,
            CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1,
            CAP_CONSUMER_ONLY_V1,
            "future_browser_cap_v9",
        ),
        limits=limits,
    )
    negotiated = negotiate_protocol(local_hello, consumer_hello)
    logical = _compact_json(
        {
            "type": "call",
            "id": "fragment-call-001",
            "method": "Gateway.GetRegistry",
            "params": {"include_internal": False, "padding": "x" * 32},
        }
    )
    subscription = {
        "type": "subscribe",
        "id": "sub-001",
        "topics": ["Tooling.ProjectionInvalidated"],
        "correlation_ids": ["corr-event-001"],
        "ttl_seconds": 60,
    }
    subscribed = {
        "type": "subscribed",
        "id": "sub-001",
        "subscription_id": "sub-001",
        "accepted": True,
        "accepted_topics": ["Tooling.ProjectionInvalidated"],
        "rejected_topics": [],
        "correlation_ids": ["corr-event-001"],
        "ttl_seconds": 60.0,
        "reason": None,
        "idempotent": False,
    }
    unsubscribe = {"type": "unsubscribe", "id": "sub-001"}
    consumer_only_call = {
        "type": "call",
        "id": "provider-call-001",
        "method": "Gateway.GetRegistry",
        "params": {},
    }
    consumer_only_error = {
        "type": "error",
        "id": "provider-call-001",
        "correlation_id": "provider-call-001",
        "error": {
            "code": 405,
            "message": "Local peer is consumer-only",
            "reason_code": "consumer_only_peer",
        },
    }
    return {
        "capability_names": [
            CAP_FRAGMENTATION_V1,
            CAP_BACKPRESSURE_V1,
            CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1,
            CAP_CONSUMER_ONLY_V1,
        ],
        "limits": limits.as_wire(),
        "local_hello": local_hello,
        "consumer_hello": consumer_hello,
        "negotiated": {
            "role": negotiated.role,
            "capabilities": sorted(negotiated.capabilities),
            "limits": negotiated.limits.as_wire(),
        },
        "fragmented_call": {
            "logical_json": logical,
            "frames": fragment_message(logical, message_id="fragment-call-001", limits=limits),
        },
        "subscriptions": {
            "subscribe": {"frame": subscription, "json": _compact_json(subscription)},
            "subscribed": {"frame": subscribed, "json": json.dumps(subscribed)},
            "unsubscribe": {"frame": unsubscribe, "json": _compact_json(unsubscribe)},
        },
        "consumer_only": {
            "call": {"frame": consumer_only_call, "json": _compact_json(consumer_only_call)},
            "error": {"frame": consumer_only_error, "json": json.dumps(consumer_only_error)},
        },
        "provider_lease_numbers": _provider_lease_number_vectors(),
    }


def _invite_vector() -> dict[str, Any]:
    payload = {
        "kind": "aurora.mesh.invite",
        "version": 1,
        "generated_at": "2026-07-25T00:00:00Z",
        "node": {"node_name": "Fixture Offerer", "peer_id": "stable-offer"},
        "signaling": {
            "provider": "mqtt",
            "mqtt_brokers": ["wss://mqtt.example.test/mqtt"],
            "app_id": "aurora-fixture",
            "room": "lab-room",
            "room_password": "synthetic-fixture-password",
        },
        "pairing": {"code": "123456", "expires_at": "2026-07-25T00:10:00Z"},
    }
    invite_json = _canonical_json(payload)
    token = "amv1." + _b64url(invite_json.encode("utf-8"))
    return {
        "payload": payload,
        "json": invite_json,
        "token": token,
        "url": f"aurora://mesh/invite?i={token}",
    }


def build_fixture() -> dict[str, Any]:
    return {
        "schema": "aurora.webrtc.web_thin.protocol_vectors.v1",
        "generated_by": "scripts/generate_webrtc_protocol_fixtures.py",
        "synthetic": True,
        "protocol_descriptor": protocol_descriptor(),
        "room_crypto": _room_crypto_vectors(),
        "signaling": {
            "topics": {
                "presence_peer": _topic("presence/peer-offer"),
                "presence_wildcard": _topic("presence/+"),
                "offer_to_peer": _topic("offer", "peer-offer"),
                "answer_to_peer": _topic("answer", "peer-offer"),
                "candidate_to_peer": _topic("candidate", "peer-offer"),
                "broadcast": _topic("broadcast"),
            },
            "subscriptions": [
                {"topic": _topic("presence/+"), "qos": 1},
                {"topic": _topic("offer", "peer-offer"), "qos": 0},
                {"topic": _topic("answer", "peer-offer"), "qos": 0},
                {"topic": _topic("candidate", "peer-offer"), "qos": 0},
                {"topic": _topic("broadcast"), "qos": 0},
            ],
            "presence_plain_json": json.dumps(
                {
                    "type": "presence",
                    "app_id": "aurora-fixture",
                    "room": "lab-room",
                    "peer_id": "peer-offer",
                }
            ),
        },
        "pairing": _pairing_vectors(),
        "reconnect": _reconnect_vector(),
        "rpc_frames": _rpc_vectors(),
        "peer_protocol": _peer_protocol_vectors(),
        "invite": _invite_vector(),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="fail if fixture file is stale")
    parser.add_argument("--output", type=Path, default=FIXTURE_PATH)
    args = parser.parse_args()

    payload = _canonical_json(build_fixture()) + "\n"
    if args.check:
        current = args.output.read_text() if args.output.exists() else ""
        if current != payload:
            print(
                f"{args.output} is stale; run scripts/generate_webrtc_protocol_fixtures.py",
                file=sys.stderr,
            )
            return 1
        print(f"{args.output} is up to date")
        return 0
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(payload)
    print(f"wrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
