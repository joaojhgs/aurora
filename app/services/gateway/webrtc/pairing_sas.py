"""Commit/reveal Short Authentication String for mesh pairing.

The SAS is a human verifier, not a credential.  It binds the exact WebRTC
offer/answer transcript (including DTLS certificate fingerprints) to both
claimed mesh identities.  A nonce commitment from each endpoint prevents an
active intermediary from choosing its nonce after learning the honest nonce.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
from dataclasses import dataclass, field
from typing import Any, Literal, cast

PAIRING_PROTOCOL_VERSION = 2
PAIRING_COMMIT_TYPE = "pairing_v2_commit"
PAIRING_REVEAL_TYPE = "pairing_v2_reveal"
PAIRING_TERMINAL_TYPE = "pairing_v2_terminal"

_CHANNEL_CONTEXT = "aurora.mesh.pairing.channel.v2"
_COMMIT_CONTEXT = b"aurora.mesh.pairing.commit.v2\0"
_TRANSCRIPT_CONTEXT = "aurora.mesh.pairing.transcript.v2"
_SESSION_CONTEXT = b"aurora.mesh.pairing.session.v2\0"
_SAS_INFO = b"aurora.mesh.pairing.sas.v2"

PairingRole = Literal["offerer", "answerer"]


class PairingProtocolError(ValueError):
    """The remote peer sent a conflicting or invalid pairing transcript."""


def _canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _sha256_hex(value: bytes | str) -> str:
    data = value.encode("utf-8") if isinstance(value, str) else value
    return hashlib.sha256(data).hexdigest()


def _b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _b64url_decode(value: str) -> bytes:
    if not value or any(character.isspace() for character in value):
        raise PairingProtocolError("Invalid pairing nonce encoding")
    try:
        return base64.b64decode(
            value + "=" * (-len(value) % 4),
            altchars=b"-_",
            validate=True,
        )
    except (ValueError, TypeError) as exc:
        raise PairingProtocolError("Invalid pairing nonce encoding") from exc


def derive_channel_binding(
    *,
    app_id: str,
    room: str,
    offerer_signaling_id: str,
    answerer_signaling_id: str,
    offer_sdp: str,
    answer_sdp: str,
) -> str:
    """Hash the exact transmitted SDP and signaling roles into one binding."""
    if not all(
        (
            app_id,
            room,
            offerer_signaling_id,
            answerer_signaling_id,
            offer_sdp,
            answer_sdp,
        )
    ):
        raise PairingProtocolError("Incomplete WebRTC transcript")
    return _sha256_hex(
        _canonical_json(
            {
                "context": _CHANNEL_CONTEXT,
                "app_id": app_id,
                "room": room,
                "offerer_signaling_id": offerer_signaling_id,
                "answerer_signaling_id": answerer_signaling_id,
                "offer_sdp_sha256": _sha256_hex(offer_sdp),
                "answer_sdp_sha256": _sha256_hex(answer_sdp),
            }
        )
    )


def pairing_identity(
    *,
    role: PairingRole,
    stable_peer_id: str,
    node_name: str,
    signaling_peer_id: str,
) -> dict[str, Any]:
    if role not in {"offerer", "answerer"}:
        raise PairingProtocolError("Invalid pairing role")
    if not stable_peer_id or not signaling_peer_id:
        raise PairingProtocolError("Pairing identity is incomplete")
    return {
        "role": role,
        "stable_peer_id": stable_peer_id,
        "node_name": node_name,
        "signaling_peer_id": signaling_peer_id,
        "supported_pairing_versions": [PAIRING_PROTOCOL_VERSION],
    }


def nonce_commitment(
    channel_binding_sha256: str,
    identity: dict[str, Any],
    nonce: bytes,
) -> str:
    if len(nonce) != 32:
        raise PairingProtocolError("Pairing nonce must contain 32 bytes")
    return hashlib.sha256(
        _COMMIT_CONTEXT + bytes.fromhex(channel_binding_sha256) + _canonical_json(identity) + nonce
    ).hexdigest()


def _hkdf_sha256(ikm: bytes, *, salt: bytes, info: bytes, length: int) -> bytes:
    """RFC 5869 HKDF using only the Python standard library."""
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    output = bytearray()
    previous = b""
    counter = 1
    while len(output) < length:
        previous = hmac.new(prk, previous + info + bytes([counter]), hashlib.sha256).digest()
        output.extend(previous)
        counter += 1
    return bytes(output[:length])


def _uniform_eight_digit_code(material: bytes) -> str:
    """Map HKDF output to 0..99,999,999 without modulo bias."""
    modulus = 100_000_000
    upper_bound = (1 << 32) // modulus * modulus
    counter = 0
    candidate_material = material
    while True:
        for offset in range(0, len(candidate_material) - 3, 4):
            value = int.from_bytes(candidate_material[offset : offset + 4], "big")
            if value < upper_bound:
                return f"{value % modulus:08d}"
        counter += 1
        candidate_material = hmac.new(
            material,
            b"aurora.mesh.pairing.sas.retry\0" + counter.to_bytes(4, "big"),
            hashlib.sha256,
        ).digest()


@dataclass(frozen=True)
class PairingSAS:
    pairing_session_id: str
    verification_code: str
    transcript_sha256: str
    channel_binding_sha256: str
    remote_stable_peer_id: str
    remote_node_name: str


def derive_pairing_sas(
    *,
    channel_binding_sha256: str,
    offerer_identity: dict[str, Any],
    offerer_commitment: str,
    offerer_nonce: bytes,
    answerer_identity: dict[str, Any],
    answerer_commitment: str,
    answerer_nonce: bytes,
    local_role: PairingRole,
) -> PairingSAS:
    transcript = {
        "context": _TRANSCRIPT_CONTEXT,
        "channel_binding_sha256": channel_binding_sha256,
        "offerer": {
            "identity": offerer_identity,
            "commitment": offerer_commitment,
            "nonce": _b64url_encode(offerer_nonce),
        },
        "answerer": {
            "identity": answerer_identity,
            "commitment": answerer_commitment,
            "nonce": _b64url_encode(answerer_nonce),
        },
    }
    transcript_digest = hashlib.sha256(_canonical_json(transcript)).digest()
    pairing_session_id = hashlib.sha256(_SESSION_CONTEXT + transcript_digest).hexdigest()
    sas_material = _hkdf_sha256(
        transcript_digest,
        salt=bytes.fromhex(channel_binding_sha256),
        info=_SAS_INFO,
        length=32,
    )
    remote_identity = answerer_identity if local_role == "offerer" else offerer_identity
    return PairingSAS(
        pairing_session_id=pairing_session_id,
        verification_code=_uniform_eight_digit_code(sas_material),
        transcript_sha256=transcript_digest.hex(),
        channel_binding_sha256=channel_binding_sha256,
        remote_stable_peer_id=str(remote_identity["stable_peer_id"]),
        remote_node_name=str(remote_identity.get("node_name") or ""),
    )


@dataclass
class PairingSASHandshake:
    """Idempotent two-message commit/reveal state for one exact PC."""

    channel_binding_sha256: str
    local_identity: dict[str, Any]
    expected_remote_identity: dict[str, Any]
    local_nonce: bytes = field(default_factory=lambda: secrets.token_bytes(32), repr=False)
    remote_commitment: str | None = None
    remote_nonce: bytes | None = field(default=None, repr=False)
    reveal_sent: bool = False
    _result: PairingSAS | None = None

    def __post_init__(self) -> None:
        local_stable = str(self.local_identity.get("stable_peer_id") or "")
        remote_stable = str(self.expected_remote_identity.get("stable_peer_id") or "")
        if local_stable == remote_stable:
            raise PairingProtocolError(
                "Local and remote mesh identities are identical; copied instance configuration"
            )
        if self.local_role == self.remote_role:
            raise PairingProtocolError("Pairing endpoints claim the same signaling role")

    @property
    def local_role(self) -> PairingRole:
        role = self.local_identity.get("role")
        if role not in {"offerer", "answerer"}:
            raise PairingProtocolError("Invalid local pairing role")
        return cast(PairingRole, role)

    @property
    def remote_role(self) -> PairingRole:
        role = self.expected_remote_identity.get("role")
        if role not in {"offerer", "answerer"}:
            raise PairingProtocolError("Invalid remote pairing role")
        return cast(PairingRole, role)

    @property
    def handshake_id(self) -> str:
        return self.channel_binding_sha256[:32]

    @property
    def local_commitment(self) -> str:
        return nonce_commitment(
            self.channel_binding_sha256,
            self.local_identity,
            self.local_nonce,
        )

    def commit_message(self) -> dict[str, Any]:
        return {
            "type": PAIRING_COMMIT_TYPE,
            "version": PAIRING_PROTOCOL_VERSION,
            "handshake_id": self.handshake_id,
            "channel_binding_sha256": self.channel_binding_sha256,
            "identity": self.local_identity,
            "nonce_commitment": self.local_commitment,
        }

    def accept_commit(self, message: dict[str, Any]) -> None:
        self._validate_common(message, PAIRING_COMMIT_TYPE)
        identity = message.get("identity")
        if identity != self.expected_remote_identity:
            raise PairingProtocolError("Remote pairing identity does not match signaling metadata")
        commitment = str(message.get("nonce_commitment") or "")
        if len(commitment) != 64 or any(
            character not in "0123456789abcdef" for character in commitment
        ):
            raise PairingProtocolError("Invalid remote pairing commitment")
        if self.remote_commitment and not secrets.compare_digest(
            self.remote_commitment,
            commitment,
        ):
            raise PairingProtocolError("Conflicting duplicate pairing commitment")
        self.remote_commitment = commitment

    def reveal_message(self) -> dict[str, Any]:
        if not self.remote_commitment:
            raise PairingProtocolError("Cannot reveal before both commitments are known")
        self.reveal_sent = True
        return {
            "type": PAIRING_REVEAL_TYPE,
            "version": PAIRING_PROTOCOL_VERSION,
            "handshake_id": self.handshake_id,
            "channel_binding_sha256": self.channel_binding_sha256,
            "nonce": _b64url_encode(self.local_nonce),
        }

    def accept_reveal(self, message: dict[str, Any]) -> PairingSAS:
        self._validate_common(message, PAIRING_REVEAL_TYPE)
        if not self.remote_commitment:
            raise PairingProtocolError("Remote revealed before committing")
        nonce = _b64url_decode(str(message.get("nonce") or ""))
        if len(nonce) != 32:
            raise PairingProtocolError("Remote pairing nonce must contain 32 bytes")
        expected = nonce_commitment(
            self.channel_binding_sha256,
            self.expected_remote_identity,
            nonce,
        )
        if not secrets.compare_digest(expected, self.remote_commitment):
            raise PairingProtocolError("Remote pairing reveal does not match its commitment")
        if self.remote_nonce is not None and not secrets.compare_digest(self.remote_nonce, nonce):
            raise PairingProtocolError("Conflicting duplicate pairing reveal")
        self.remote_nonce = nonce
        if self._result is None:
            if self.local_role == "offerer":
                offerer_identity = self.local_identity
                offerer_commitment = self.local_commitment
                offerer_nonce = self.local_nonce
                answerer_identity = self.expected_remote_identity
                answerer_commitment = self.remote_commitment
                answerer_nonce = nonce
            else:
                offerer_identity = self.expected_remote_identity
                offerer_commitment = self.remote_commitment
                offerer_nonce = nonce
                answerer_identity = self.local_identity
                answerer_commitment = self.local_commitment
                answerer_nonce = self.local_nonce
            self._result = derive_pairing_sas(
                channel_binding_sha256=self.channel_binding_sha256,
                offerer_identity=offerer_identity,
                offerer_commitment=offerer_commitment,
                offerer_nonce=offerer_nonce,
                answerer_identity=answerer_identity,
                answerer_commitment=answerer_commitment,
                answerer_nonce=answerer_nonce,
                local_role=self.local_role,
            )
        return self._result

    def _validate_common(self, message: dict[str, Any], expected_type: str) -> None:
        if message.get("type") != expected_type:
            raise PairingProtocolError("Unexpected pairing control message")
        if message.get("version") != PAIRING_PROTOCOL_VERSION:
            raise PairingProtocolError("Unsupported pairing protocol version")
        if message.get("handshake_id") != self.handshake_id:
            raise PairingProtocolError("Pairing message belongs to a stale connection")
        if not secrets.compare_digest(
            str(message.get("channel_binding_sha256") or ""),
            self.channel_binding_sha256,
        ):
            raise PairingProtocolError("Pairing channel binding mismatch")
