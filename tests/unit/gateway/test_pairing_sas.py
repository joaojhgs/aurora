from __future__ import annotations

import base64
from dataclasses import dataclass

import pytest

from app.services.gateway.webrtc.pairing_sas import (
    PairingProtocolError,
    PairingRole,
    PairingSAS,
    PairingSASHandshake,
    derive_channel_binding,
    pairing_identity,
)

_OFFER_SDP = "v=0\r\no=- 100 2 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 AA:BB\r\n"
_ANSWER_SDP = "v=0\r\no=- 200 2 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 CC:DD\r\n"
_OFFERER_NONCE = bytes(range(32))
_ANSWERER_NONCE = bytes(range(32, 64))


@dataclass(frozen=True)
class _CompletedHandshake:
    offerer: PairingSASHandshake
    answerer: PairingSASHandshake
    offerer_result: PairingSAS
    answerer_result: PairingSAS


def _paired_handshakes(
    *,
    offer_sdp: str = _OFFER_SDP,
    answer_sdp: str = _ANSWER_SDP,
    offerer_stable_id: str = "stable-z-offerer",
    answerer_stable_id: str = "stable-a-answerer",
    offerer_node_name: str = "Aurora Z",
    answerer_node_name: str = "Aurora A",
    offerer_nonce: bytes = _OFFERER_NONCE,
    answerer_nonce: bytes = _ANSWERER_NONCE,
) -> tuple[PairingSASHandshake, PairingSASHandshake]:
    channel_binding = derive_channel_binding(
        app_id="aurora-test-app",
        room="shared-test-room",
        offerer_signaling_id="signal-z-offerer",
        answerer_signaling_id="signal-a-answerer",
        offer_sdp=offer_sdp,
        answer_sdp=answer_sdp,
    )
    offerer_identity = pairing_identity(
        role="offerer",
        stable_peer_id=offerer_stable_id,
        node_name=offerer_node_name,
        signaling_peer_id="signal-z-offerer",
    )
    answerer_identity = pairing_identity(
        role="answerer",
        stable_peer_id=answerer_stable_id,
        node_name=answerer_node_name,
        signaling_peer_id="signal-a-answerer",
    )
    return (
        PairingSASHandshake(
            channel_binding_sha256=channel_binding,
            local_identity=offerer_identity,
            expected_remote_identity=answerer_identity,
            local_nonce=offerer_nonce,
        ),
        PairingSASHandshake(
            channel_binding_sha256=channel_binding,
            local_identity=answerer_identity,
            expected_remote_identity=offerer_identity,
            local_nonce=answerer_nonce,
        ),
    )


def _complete_handshake(**kwargs: object) -> _CompletedHandshake:
    offerer, answerer = _paired_handshakes(**kwargs)
    offerer_commit = offerer.commit_message()
    answerer_commit = answerer.commit_message()
    offerer.accept_commit(answerer_commit)
    answerer.accept_commit(offerer_commit)
    offerer_reveal = offerer.reveal_message()
    answerer_reveal = answerer.reveal_message()
    return _CompletedHandshake(
        offerer=offerer,
        answerer=answerer,
        offerer_result=offerer.accept_reveal(answerer_reveal),
        answerer_result=answerer.accept_reveal(offerer_reveal),
    )


def _core_result(result: PairingSAS) -> tuple[str, str, str, str]:
    return (
        result.pairing_session_id,
        result.verification_code,
        result.transcript_sha256,
        result.channel_binding_sha256,
    )


def _encoded_nonce(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def test_role_ordered_handshake_derives_identical_session_and_sas() -> None:
    """Role ordering, not lexical peer-ID order, defines the shared transcript."""
    completed = _complete_handshake()

    assert _core_result(completed.offerer_result) == _core_result(completed.answerer_result)
    assert completed.offerer_result.remote_stable_peer_id == "stable-a-answerer"
    assert completed.offerer_result.remote_node_name == "Aurora A"
    assert completed.answerer_result.remote_stable_peer_id == "stable-z-offerer"
    assert completed.answerer_result.remote_node_name == "Aurora Z"
    assert len(completed.offerer_result.pairing_session_id) == 64
    assert len(completed.offerer_result.transcript_sha256) == 64
    assert len(completed.offerer_result.channel_binding_sha256) == 64
    assert len(completed.offerer_result.verification_code) == 8
    assert completed.offerer_result.verification_code.isdecimal()


@pytest.mark.parametrize(
    ("changed_kwargs", "expected_binding_change"),
    [
        ({"offer_sdp": f"{_OFFER_SDP}a=ice-ufrag:changed\r\n"}, True),
        ({"answer_sdp": f"{_ANSWER_SDP}a=ice-pwd:changed\r\n"}, True),
        ({"answerer_nonce": b"x" * 32}, False),
        ({"answerer_node_name": "Aurora A renamed"}, False),
    ],
)
def test_sdp_or_transcript_change_produces_a_new_session_and_sas(
    changed_kwargs: dict[str, object],
    expected_binding_change: bool,
) -> None:
    baseline = _complete_handshake()
    changed = _complete_handshake(**changed_kwargs)

    assert (
        changed.offerer_result.channel_binding_sha256
        != baseline.offerer_result.channel_binding_sha256
    ) is expected_binding_change
    assert changed.offerer_result.transcript_sha256 != baseline.offerer_result.transcript_sha256
    assert changed.offerer_result.pairing_session_id != baseline.offerer_result.pairing_session_id
    assert changed.offerer_result.verification_code != baseline.offerer_result.verification_code
    assert _core_result(changed.offerer_result) == _core_result(changed.answerer_result)


def test_tampered_reveal_is_rejected_before_sas_derivation() -> None:
    offerer, answerer = _paired_handshakes()
    offerer.accept_commit(answerer.commit_message())
    answerer.accept_commit(offerer.commit_message())
    tampered_reveal = answerer.reveal_message()
    tampered_reveal["nonce"] = _encoded_nonce(b"tampered-reveal".ljust(32, b"!"))

    with pytest.raises(PairingProtocolError, match="does not match its commitment"):
        offerer.accept_reveal(tampered_reveal)


def test_duplicate_commit_and_reveal_are_idempotent_but_conflicts_fail() -> None:
    offerer, answerer = _paired_handshakes()
    answerer_commit = answerer.commit_message()
    offerer.accept_commit(answerer_commit)
    offerer.accept_commit(dict(answerer_commit))

    conflicting_commit = dict(answerer_commit)
    conflicting_commit["nonce_commitment"] = "0" * 64
    with pytest.raises(PairingProtocolError, match="Conflicting duplicate"):
        offerer.accept_commit(conflicting_commit)

    answerer.accept_commit(offerer.commit_message())
    answerer_reveal = answerer.reveal_message()
    first_result = offerer.accept_reveal(answerer_reveal)
    duplicate_result = offerer.accept_reveal(dict(answerer_reveal))
    assert duplicate_result is first_result

    conflicting_reveal = dict(answerer_reveal)
    conflicting_reveal["nonce"] = _encoded_nonce(b"conflicting-reveal".ljust(32, b"!"))
    with pytest.raises(PairingProtocolError):
        offerer.accept_reveal(conflicting_reveal)


@pytest.mark.parametrize("local_role", ["offerer", "answerer"])
def test_copied_stable_peer_identity_is_rejected(local_role: PairingRole) -> None:
    remote_role: PairingRole = "answerer" if local_role == "offerer" else "offerer"
    local_identity = pairing_identity(
        role=local_role,
        stable_peer_id="copied-stable-peer-id",
        node_name="Aurora copy one",
        signaling_peer_id="signal-local",
    )
    remote_identity = pairing_identity(
        role=remote_role,
        stable_peer_id="copied-stable-peer-id",
        node_name="Aurora copy two",
        signaling_peer_id="signal-remote",
    )

    with pytest.raises(PairingProtocolError, match="copied instance configuration"):
        PairingSASHandshake(
            channel_binding_sha256="d" * 64,
            local_identity=local_identity,
            expected_remote_identity=remote_identity,
            local_nonce=_OFFERER_NONCE,
        )
