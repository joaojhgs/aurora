"""Additive WebRTC peer protocol helpers for thin-shell interoperability.

The helpers in this module are intentionally runtime-neutral: they define the
small, versioned hello/capability envelope and JSON-safe fragmentation frames
that browser/WebView and Python peers can share before RTCClient integration
flips capability advertising on.  No message contents are logged here.
"""

from __future__ import annotations

import base64
import hashlib
import math
import re
import time
import uuid
from collections import OrderedDict
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

CAP_FRAGMENTATION_V1 = "fragmentation_v1"
CAP_BACKPRESSURE_V1 = "backpressure_v1"
CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1 = "scoped_event_subscriptions_v1"
CAP_CONSUMER_ONLY_V1 = "consumer_only_v1"
CAP_PROVIDER_LEASE_V1 = "provider_lease_v1"

KNOWN_PEER_CAPABILITIES = frozenset(
    {
        CAP_FRAGMENTATION_V1,
        CAP_BACKPRESSURE_V1,
        CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1,
        CAP_CONSUMER_ONLY_V1,
        CAP_PROVIDER_LEASE_V1,
    }
)
DEFAULT_PEER_CAPABILITIES = (
    CAP_FRAGMENTATION_V1,
    CAP_BACKPRESSURE_V1,
    CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1,
    CAP_PROVIDER_LEASE_V1,
)

PEER_PROTOCOL_VERSION = 1
PROTOCOL_HELLO_TYPE = "protocol_hello"
FRAGMENT_FRAME_TYPE = "fragment"

# R6's "going away, keep my credential" signal.
#
# A peer shed to stay inside a connection budget is not a peer that was lost.
# It leaves deliberately, it keeps its credential, and coming back must not
# cost a re-pair.  Silence cannot say that: silence is what a lost peer also
# produces, and after ``stale_peer_timeout_s`` the registry marks it stale.
# Nor can ``provider_unavailable`` say it, which means something else entirely
# (the provider is gone; stop routing to it).  So the intent gets its own
# typed frame and its own peer status.
MESH_PEER_STANDBY_TYPE = "mesh_peer_standby_v1"
# Why a peer stood down.  Machine-readable, never product copy.
MESH_PEER_STANDBY_REASON_CODES = frozenset(
    {
        # Shed to stay inside the surface's connection budget (R6).
        "connection_budget",
        # The operating system suspended the surface (R7's iOS path).
        "surface_suspended",
        # A person disconnected this device on purpose.
        "user_requested",
    }
)
PEER_ROLES = frozenset({"provider", "consumer", "hybrid"})
PeerRole = Literal["provider", "consumer", "hybrid"]

DEFAULT_FRAGMENT_PAYLOAD_BYTES = 16 * 1024
DEFAULT_MAX_LOGICAL_BYTES = 8 * 1024 * 1024
DEFAULT_MAX_PEER_AGGREGATE_BYTES = 16 * 1024 * 1024
DEFAULT_INCOMPLETE_TTL_SECONDS = 30.0
DEFAULT_MAX_FRAGMENTS = 4096
DEFAULT_MAX_COMPLETED_TOMBSTONES = 4096
DEFAULT_MAX_COMPLETED_TOMBSTONES_PER_PEER = 1024
_MAX_ID_LENGTH = 128
_MAX_CONTENT_TYPE_LENGTH = 128
_MAX_CAPABILITIES = 32
_MAX_CAPABILITY_LENGTH = 96
_BASE64URL_RE = re.compile(r"^[A-Za-z0-9_-]*$")
_MAX_REASON_CODE_LENGTH = 128
_MAX_SAFE_INTEGER = (2**53) - 1


class PeerProtocolError(ValueError):
    """Raised when a peer protocol envelope or frame is invalid."""


class FragmentProtocolError(PeerProtocolError):
    """Raised when a fragmentation frame is invalid or exceeds limits."""


@dataclass(frozen=True, slots=True)
class ProviderLeaseFrame:
    """Strict provider availability lease frame shared with TypeScript peers."""

    type: Literal["provider_lease", "provider_unavailable"]
    peer_id: str
    connection_epoch: str
    availability_revision: int
    issued_at_ms: int
    expires_at_ms: int
    available: bool | None = None
    reason_code: str | None = None

    @property
    def is_available(self) -> bool:
        """Return whether this frame advertises a bindable provider."""

        if self.type == "provider_unavailable":
            return False
        return self.available is not False


@dataclass(frozen=True, slots=True)
class MeshPeerStandbyFrame:
    """A peer announcing a deliberate departure that keeps its credential.

    ``resume_expected`` is a new optional field rather than a meaning loaded
    onto an existing one, following the precedent R3 set with ``retry_when``
    on the deferral body: additive, so a peer that has never heard of it still
    reads a well-formed departure notice and behaves sanely.
    """

    type: Literal["mesh_peer_standby_v1"]
    peer_id: str
    reason_code: str
    resume_expected: bool | None = None

    @property
    def resumes(self) -> bool:
        """Whether the sender expects to come back on this credential."""

        return self.resume_expected is not False


@dataclass(frozen=True)
class PeerProtocolLimits:
    """Bounded protocol limits shared by hello negotiation and reassembly."""

    fragment_payload_bytes: int = DEFAULT_FRAGMENT_PAYLOAD_BYTES
    max_logical_bytes: int = DEFAULT_MAX_LOGICAL_BYTES
    max_peer_aggregate_bytes: int = DEFAULT_MAX_PEER_AGGREGATE_BYTES
    incomplete_ttl_seconds: float = DEFAULT_INCOMPLETE_TTL_SECONDS
    max_fragments: int = DEFAULT_MAX_FRAGMENTS

    def __post_init__(self) -> None:
        if (
            self.fragment_payload_bytes <= 0
            or self.fragment_payload_bytes > DEFAULT_FRAGMENT_PAYLOAD_BYTES
        ):
            raise PeerProtocolError("fragment_payload_bytes must be in 1..16384")
        if self.max_logical_bytes <= 0 or self.max_logical_bytes > DEFAULT_MAX_LOGICAL_BYTES:
            raise PeerProtocolError("max_logical_bytes must be in 1..8388608")
        if self.max_peer_aggregate_bytes < self.max_logical_bytes:
            raise PeerProtocolError("max_peer_aggregate_bytes must be >= max_logical_bytes")
        if self.max_peer_aggregate_bytes > DEFAULT_MAX_PEER_AGGREGATE_BYTES:
            raise PeerProtocolError("max_peer_aggregate_bytes must be <= 16777216")
        if (
            self.incomplete_ttl_seconds <= 0
            or self.incomplete_ttl_seconds > DEFAULT_INCOMPLETE_TTL_SECONDS
        ):
            raise PeerProtocolError("incomplete_ttl_seconds must be in 0..30")
        if self.max_fragments <= 0 or self.max_fragments > DEFAULT_MAX_FRAGMENTS:
            raise PeerProtocolError("max_fragments must be in 1..4096")

    def as_wire(self) -> dict[str, int | float]:
        """Return the hello-safe JSON representation."""

        return {
            "fragment_payload_bytes": self.fragment_payload_bytes,
            "max_logical_bytes": self.max_logical_bytes,
            "max_peer_aggregate_bytes": self.max_peer_aggregate_bytes,
            "incomplete_ttl_seconds": self.incomplete_ttl_seconds,
            "max_fragments": self.max_fragments,
        }


@dataclass(frozen=True)
class ProtocolHello:
    """Parsed additive peer hello."""

    role: PeerRole
    capabilities: frozenset[str]
    limits: PeerProtocolLimits
    raw_capabilities: tuple[str, ...]


@dataclass(frozen=True)
class NegotiatedPeerProtocol:
    """Common protocol features after intersecting local and remote hellos."""

    role: PeerRole
    capabilities: frozenset[str]
    limits: PeerProtocolLimits

    def supports(self, capability: str) -> bool:
        """Return whether a known capability was negotiated."""

        return capability in self.capabilities


@dataclass
class _FragmentAssembly:
    peer_id: str
    message_id: str
    total: int
    total_len: int
    digest: str
    content_type: str
    created_at: float
    updated_at: float
    fragments: dict[int, bytes] = field(default_factory=dict)

    @property
    def stored_bytes(self) -> int:
        return sum(len(fragment) for fragment in self.fragments.values())


def _require_identifier(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not value or len(value) > _MAX_ID_LENGTH:
        raise PeerProtocolError(f"{field_name} must be a non-empty bounded string")
    return value


def _require_bounded_string(value: Any, field_name: str, max_length: int) -> str:
    if not isinstance(value, str) or not value or len(value) > max_length:
        raise PeerProtocolError(f"{field_name} must be a non-empty bounded string")
    return value


def _require_integer(value: Any, field_name: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool):
        raise PeerProtocolError(f"{field_name} must be an integer in {minimum}..{maximum}")
    if isinstance(value, float):
        if not math.isfinite(value) or not value.is_integer():
            raise PeerProtocolError(f"{field_name} must be an integer in {minimum}..{maximum}")
        value = int(value)
    if not isinstance(value, int) or value < minimum or value > maximum:
        raise PeerProtocolError(f"{field_name} must be an integer in {minimum}..{maximum}")
    return value


def _require_optional_bool(value: Any, field_name: str) -> bool:
    if isinstance(value, bool):
        return value
    raise PeerProtocolError(f"{field_name} must be boolean")


def _parse_role(value: Any) -> PeerRole:
    if value not in PEER_ROLES:
        raise PeerProtocolError("role must be provider, consumer, or hybrid")
    return value  # type: ignore[return-value]


def _parse_capabilities(value: Any) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list | tuple) or len(value) > _MAX_CAPABILITIES:
        raise PeerProtocolError("capabilities must be a bounded list")
    parsed: list[str] = []
    seen: set[str] = set()
    for capability in value:
        if (
            not isinstance(capability, str)
            or not capability
            or len(capability) > _MAX_CAPABILITY_LENGTH
        ):
            raise PeerProtocolError("capability names must be bounded strings")
        if capability not in seen:
            parsed.append(capability)
            seen.add(capability)
    return tuple(parsed)


def _parse_limits(value: Any | None) -> PeerProtocolLimits:
    if value is None:
        return PeerProtocolLimits()
    if not isinstance(value, Mapping):
        raise PeerProtocolError("limits must be an object")
    kwargs: dict[str, Any] = {}
    for field_name in (
        "fragment_payload_bytes",
        "max_logical_bytes",
        "max_peer_aggregate_bytes",
        "incomplete_ttl_seconds",
        "max_fragments",
    ):
        if field_name in value:
            kwargs[field_name] = value[field_name]
    if any(isinstance(v, bool) or not isinstance(v, int | float) for v in kwargs.values()):
        raise PeerProtocolError("limits must be numeric and not boolean")
    return PeerProtocolLimits(**kwargs)


def build_protocol_hello(
    *,
    role: PeerRole = "hybrid",
    capabilities: Iterable[str] = DEFAULT_PEER_CAPABILITIES,
    limits: PeerProtocolLimits | None = None,
) -> dict[str, Any]:
    """Build a deterministic additive protocol hello frame.

    Unknown capability strings may be included for future versions; parsers keep
    them in ``raw_capabilities`` but negotiators only enable known common names.
    """

    parsed_role = _parse_role(role)
    raw_capabilities = _parse_capabilities(list(capabilities))
    bounded_limits = limits or PeerProtocolLimits()
    return {
        "type": PROTOCOL_HELLO_TYPE,
        "v": PEER_PROTOCOL_VERSION,
        "role": parsed_role,
        "capabilities": list(raw_capabilities),
        "limits": bounded_limits.as_wire(),
    }


def parse_protocol_hello(frame: Mapping[str, Any]) -> ProtocolHello:
    """Parse and strictly validate a protocol hello frame."""

    if not isinstance(frame, Mapping):
        raise PeerProtocolError("hello must be an object")
    if frame.get("type") != PROTOCOL_HELLO_TYPE or frame.get("v") != PEER_PROTOCOL_VERSION:
        raise PeerProtocolError("unsupported protocol hello")
    role = _parse_role(frame.get("role"))
    raw_capabilities = _parse_capabilities(frame.get("capabilities", ()))
    limits = _parse_limits(frame.get("limits"))
    return ProtocolHello(
        role=role,
        capabilities=frozenset(cap for cap in raw_capabilities if cap in KNOWN_PEER_CAPABILITIES),
        limits=limits,
        raw_capabilities=raw_capabilities,
    )


def negotiate_protocol(
    local_hello: Mapping[str, Any] | ProtocolHello,
    remote_hello: Mapping[str, Any] | ProtocolHello,
) -> NegotiatedPeerProtocol:
    """Intersect additive features and choose the strictest shared limits."""

    local = (
        local_hello if isinstance(local_hello, ProtocolHello) else parse_protocol_hello(local_hello)
    )
    remote = (
        remote_hello
        if isinstance(remote_hello, ProtocolHello)
        else parse_protocol_hello(remote_hello)
    )
    capabilities = frozenset(local.capabilities & remote.capabilities)
    return NegotiatedPeerProtocol(
        role=remote.role,
        capabilities=capabilities,
        limits=PeerProtocolLimits(
            fragment_payload_bytes=min(
                local.limits.fragment_payload_bytes, remote.limits.fragment_payload_bytes
            ),
            max_logical_bytes=min(local.limits.max_logical_bytes, remote.limits.max_logical_bytes),
            max_peer_aggregate_bytes=min(
                local.limits.max_peer_aggregate_bytes,
                remote.limits.max_peer_aggregate_bytes,
            ),
            incomplete_ttl_seconds=min(
                local.limits.incomplete_ttl_seconds, remote.limits.incomplete_ttl_seconds
            ),
            max_fragments=min(local.limits.max_fragments, remote.limits.max_fragments),
        ),
    )


def parse_provider_lease_frame(frame: Mapping[str, Any]) -> ProviderLeaseFrame:
    """Parse a provider lease/unavailable frame using the TypeScript wire bounds."""

    if not isinstance(frame, Mapping):
        raise PeerProtocolError("provider lease frame must be an object")
    frame_type = frame.get("type")
    if frame_type not in {"provider_lease", "provider_unavailable"}:
        raise PeerProtocolError("unsupported provider lease frame")
    parsed = ProviderLeaseFrame(
        type=frame_type,  # type: ignore[arg-type]
        peer_id=_require_identifier(frame.get("peer_id"), "peer_id"),
        connection_epoch=_require_identifier(frame.get("connection_epoch"), "connection_epoch"),
        availability_revision=_require_integer(
            frame.get("availability_revision"),
            "availability_revision",
            0,
            _MAX_SAFE_INTEGER,
        ),
        issued_at_ms=_require_integer(
            frame.get("issued_at_ms"), "issued_at_ms", 0, _MAX_SAFE_INTEGER
        ),
        expires_at_ms=_require_integer(
            frame.get("expires_at_ms"),
            "expires_at_ms",
            0,
            _MAX_SAFE_INTEGER,
        ),
        available=_require_optional_bool(frame["available"], "available")
        if "available" in frame
        else None,
        reason_code=_require_bounded_string(
            frame["reason_code"], "reason_code", _MAX_REASON_CODE_LENGTH
        )
        if "reason_code" in frame
        else None,
    )
    if parsed.expires_at_ms < parsed.issued_at_ms:
        raise PeerProtocolError("provider lease expires before issue time")
    return parsed


def build_mesh_peer_standby(
    *,
    peer_id: str,
    reason_code: str,
    resume_expected: bool | None = None,
) -> dict[str, Any]:
    """Build the frame a peer sends when it stands down on purpose."""

    frame: dict[str, Any] = {
        "type": MESH_PEER_STANDBY_TYPE,
        "peer_id": _require_identifier(peer_id, "peer_id"),
        "reason_code": _require_standby_reason_code(reason_code),
    }
    if resume_expected is not None:
        frame["resume_expected"] = _require_optional_bool(resume_expected, "resume_expected")
    return frame


def parse_mesh_peer_standby_frame(frame: Mapping[str, Any]) -> MeshPeerStandbyFrame:
    """Parse a standby announcement using the TypeScript wire bounds."""

    if not isinstance(frame, Mapping):
        raise PeerProtocolError("mesh peer standby frame must be an object")
    if frame.get("type") != MESH_PEER_STANDBY_TYPE:
        raise PeerProtocolError("unsupported mesh peer standby frame")
    return MeshPeerStandbyFrame(
        type=MESH_PEER_STANDBY_TYPE,
        peer_id=_require_identifier(frame.get("peer_id"), "peer_id"),
        reason_code=_require_standby_reason_code(frame.get("reason_code")),
        resume_expected=_require_optional_bool(frame["resume_expected"], "resume_expected")
        if "resume_expected" in frame
        else None,
    )


def _require_standby_reason_code(value: Any) -> str:
    reason_code = _require_bounded_string(value, "reason_code", _MAX_REASON_CODE_LENGTH)
    if reason_code not in MESH_PEER_STANDBY_REASON_CODES:
        raise PeerProtocolError("reason_code is not a known standby reason")
    return reason_code


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64url_decode(value: Any) -> bytes:
    if not isinstance(value, str) or len(value) > (DEFAULT_FRAGMENT_PAYLOAD_BYTES * 2):
        raise FragmentProtocolError("payload_b64 must be a bounded string")
    if len(value) % 4 == 1 or not _BASE64URL_RE.fullmatch(value):
        raise FragmentProtocolError("payload_b64 is not base64url")
    try:
        return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except Exception as exc:  # pragma: no cover - defensive, regex catches normal cases
        raise FragmentProtocolError("payload_b64 is not base64url") from exc


def fragment_message(
    message: str,
    *,
    message_id: str | None = None,
    content_type: str = "application/json",
    limits: PeerProtocolLimits | None = None,
) -> list[dict[str, Any]]:
    """Split a UTF-8 logical message into deterministic JSON fragment frames."""

    if not isinstance(message, str):
        raise FragmentProtocolError("message must be a string")
    if (
        not isinstance(content_type, str)
        or not content_type
        or len(content_type) > _MAX_CONTENT_TYPE_LENGTH
    ):
        raise FragmentProtocolError("content_type must be a non-empty bounded string")
    bounded_limits = limits or PeerProtocolLimits()
    payload = message.encode("utf-8")
    if len(payload) > bounded_limits.max_logical_bytes:
        raise FragmentProtocolError("logical message exceeds maximum size")
    fragment_count = max(1, math.ceil(len(payload) / bounded_limits.fragment_payload_bytes))
    if fragment_count > bounded_limits.max_fragments:
        raise FragmentProtocolError("logical message exceeds maximum fragment count")
    frame_id = _require_identifier(message_id or uuid.uuid4().hex, "message_id")
    digest = hashlib.sha256(payload).hexdigest()
    frames: list[dict[str, Any]] = []
    for seq in range(fragment_count):
        start = seq * bounded_limits.fragment_payload_bytes
        chunk = payload[start : start + bounded_limits.fragment_payload_bytes]
        frames.append(
            {
                "type": FRAGMENT_FRAME_TYPE,
                "v": PEER_PROTOCOL_VERSION,
                "id": frame_id,
                "seq": seq,
                "total": fragment_count,
                "total_len": len(payload),
                "sha256": digest,
                "content_type": content_type,
                "payload_b64": _b64url_encode(chunk),
            }
        )
    return frames


def _parse_fragment_frame(
    frame: Mapping[str, Any], limits: PeerProtocolLimits
) -> tuple[str, int, int, int, str, str, bytes]:
    if not isinstance(frame, Mapping):
        raise FragmentProtocolError("fragment must be an object")
    if frame.get("type") != FRAGMENT_FRAME_TYPE or frame.get("v") != PEER_PROTOCOL_VERSION:
        raise FragmentProtocolError("unsupported fragment frame")
    message_id = _require_identifier(frame.get("id"), "id")
    seq = frame.get("seq")
    total = frame.get("total")
    total_len = frame.get("total_len")
    if not isinstance(seq, int) or not isinstance(total, int) or not isinstance(total_len, int):
        raise FragmentProtocolError("seq, total, and total_len must be integers")
    if total <= 0 or total > limits.max_fragments:
        raise FragmentProtocolError("invalid fragment total")
    if seq < 0 or seq >= total:
        raise FragmentProtocolError("invalid fragment sequence")
    if total_len < 0 or total_len > limits.max_logical_bytes:
        raise FragmentProtocolError("invalid total_len")
    if total != max(1, math.ceil(total_len / limits.fragment_payload_bytes)):
        raise FragmentProtocolError("fragment count does not match limits")
    digest = frame.get("sha256")
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise FragmentProtocolError("sha256 must be lowercase hex")
    content_type = frame.get("content_type")
    if (
        not isinstance(content_type, str)
        or not content_type
        or len(content_type) > _MAX_CONTENT_TYPE_LENGTH
    ):
        raise FragmentProtocolError("content_type must be a bounded string")
    payload = _b64url_decode(frame.get("payload_b64"))
    expected_max = limits.fragment_payload_bytes
    if len(payload) > expected_max:
        raise FragmentProtocolError("fragment payload exceeds negotiated size")
    if seq < total - 1 and len(payload) != expected_max:
        raise FragmentProtocolError("non-final fragment has invalid length")
    if seq == total - 1:
        final_len = total_len - (limits.fragment_payload_bytes * (total - 1))
        if len(payload) != final_len:
            raise FragmentProtocolError("final fragment has invalid length")
    return message_id, seq, total, total_len, digest, content_type, payload


class FragmentReassembler:
    """Synchronously reassemble per-peer fragment frames with bounded memory."""

    def __init__(
        self,
        *,
        limits: PeerProtocolLimits | None = None,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self._limits = limits or PeerProtocolLimits()
        self._clock = clock or time.monotonic
        self._assemblies: dict[tuple[str, str], _FragmentAssembly] = {}
        self._completed: OrderedDict[tuple[str, str], float] = OrderedDict()

    @property
    def limits(self) -> PeerProtocolLimits:
        """Return configured bounds."""

        return self._limits

    def receive(self, peer_id: str, frame: Mapping[str, Any]) -> str | None:
        """Accept one fragment frame; return completed UTF-8 JSON exactly once."""

        peer = _require_identifier(peer_id, "peer_id")
        now = self._clock()
        self.expire(now=now)
        try:
            message_id, seq, total, total_len, digest, content_type, payload = (
                _parse_fragment_frame(frame, self._limits)
            )
        except FragmentProtocolError:
            frame_id = frame.get("id") if isinstance(frame, Mapping) else None
            if isinstance(frame_id, str) and len(frame_id) <= _MAX_ID_LENGTH:
                self._drop((peer, frame_id))
            raise
        key = (peer, message_id)
        if key in self._completed:
            self._completed.move_to_end(key)
            return None

        assembly = self._assemblies.get(key)
        if assembly is None:
            projected = self._peer_stored_bytes(peer) + len(payload)
            if projected > self._limits.max_peer_aggregate_bytes:
                self._drop(key)
                raise FragmentProtocolError("peer fragment aggregate quota exceeded")
            assembly = _FragmentAssembly(
                peer_id=peer,
                message_id=message_id,
                total=total,
                total_len=total_len,
                digest=digest,
                content_type=content_type,
                created_at=now,
                updated_at=now,
            )
            self._assemblies[key] = assembly
        else:
            if (
                assembly.total != total
                or assembly.total_len != total_len
                or assembly.digest != digest
                or assembly.content_type != content_type
            ):
                self._drop(key)
                raise FragmentProtocolError("fragment metadata conflicts with existing assembly")
            existing = assembly.fragments.get(seq)
            if existing is not None:
                if existing == payload:
                    assembly.updated_at = now
                    return None
                self._drop(key)
                raise FragmentProtocolError("fragment duplicate conflicts with existing payload")
            projected = self._peer_stored_bytes(peer) + len(payload)
            if projected > self._limits.max_peer_aggregate_bytes:
                self._drop(key)
                raise FragmentProtocolError("peer fragment aggregate quota exceeded")

        assembly.fragments[seq] = payload
        assembly.updated_at = now
        if len(assembly.fragments) != assembly.total:
            return None

        ordered = b"".join(assembly.fragments[index] for index in range(assembly.total))
        if len(ordered) != assembly.total_len:
            self._drop(key)
            raise FragmentProtocolError("reassembled length mismatch")
        if hashlib.sha256(ordered).hexdigest() != assembly.digest:
            self._drop(key)
            raise FragmentProtocolError("reassembled sha256 mismatch")
        try:
            logical = ordered.decode("utf-8")
        except UnicodeDecodeError as exc:
            self._drop(key)
            raise FragmentProtocolError("reassembled payload is not UTF-8") from exc
        self._drop(key)
        self._remember_completed(key, now)
        return logical

    def expire(self, *, now: float | None = None) -> int:
        """Drop incomplete assemblies older than the configured TTL."""

        current = self._clock() if now is None else now
        expired = [
            key
            for key, assembly in self._assemblies.items()
            if current - assembly.updated_at > self._limits.incomplete_ttl_seconds
        ]
        expired_tombstones = [
            key
            for key, completed_at in self._completed.items()
            if current - completed_at > self._limits.incomplete_ttl_seconds
        ]
        for key in expired:
            self._drop(key)
        for key in expired_tombstones:
            self._completed.pop(key, None)
        return len(expired) + len(expired_tombstones)

    def cleanup_peer(self, peer_id: str) -> int:
        """Drop all incomplete and completed state for one peer."""

        peer = _require_identifier(peer_id, "peer_id")
        keys = [key for key in self._assemblies if key[0] == peer]
        for key in keys:
            self._drop(key)
        completed_keys = [key for key in self._completed if key[0] == peer]
        for key in completed_keys:
            self._completed.pop(key, None)
        return len(keys) + len(completed_keys)

    def incomplete_count(self, peer_id: str | None = None) -> int:
        """Return incomplete assembly count, optionally scoped to a peer."""

        if peer_id is None:
            return len(self._assemblies)
        peer = _require_identifier(peer_id, "peer_id")
        return sum(1 for key in self._assemblies if key[0] == peer)

    def _peer_stored_bytes(self, peer_id: str) -> int:
        return sum(
            assembly.stored_bytes for key, assembly in self._assemblies.items() if key[0] == peer_id
        )

    def completed_count(self, peer_id: str | None = None) -> int:
        """Return replay tombstone count, optionally scoped to a peer."""

        if peer_id is None:
            return len(self._completed)
        peer = _require_identifier(peer_id, "peer_id")
        return sum(1 for key in self._completed if key[0] == peer)

    def _remember_completed(self, key: tuple[str, str], completed_at: float) -> None:
        self._completed[key] = completed_at
        self._completed.move_to_end(key)
        peer_id = key[0]
        while len(self._completed) > DEFAULT_MAX_COMPLETED_TOMBSTONES:
            self._completed.popitem(last=False)
        peer_keys = [
            completed_key for completed_key in self._completed if completed_key[0] == peer_id
        ]
        overflow = len(peer_keys) - DEFAULT_MAX_COMPLETED_TOMBSTONES_PER_PEER
        for completed_key in peer_keys[: max(0, overflow)]:
            self._completed.pop(completed_key, None)

    def _drop(self, key: tuple[str, str]) -> None:
        self._assemblies.pop(key, None)
