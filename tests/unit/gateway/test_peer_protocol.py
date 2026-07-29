from __future__ import annotations

import pytest

from app.services.gateway.webrtc.peer_protocol import (
    CAP_BACKPRESSURE_V1,
    CAP_CONSUMER_ONLY_V1,
    CAP_FRAGMENTATION_V1,
    CAP_PROVIDER_LEASE_V1,
    CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1,
    FragmentProtocolError,
    FragmentReassembler,
    PeerProtocolError,
    PeerProtocolLimits,
    build_protocol_hello,
    fragment_message,
    negotiate_protocol,
    parse_protocol_hello,
    parse_provider_lease_frame,
)


def _small_limits(**overrides: object) -> PeerProtocolLimits:
    values = {
        "fragment_payload_bytes": 8,
        "max_logical_bytes": 64,
        "max_peer_aggregate_bytes": 128,
        "incomplete_ttl_seconds": 1.0,
        "max_fragments": 16,
    }
    values.update(overrides)
    return PeerProtocolLimits(**values)


@pytest.mark.unit
def test_protocol_hello_fallback_and_common_capability_negotiation() -> None:
    local = build_protocol_hello(
        role="hybrid",
        capabilities=(
            CAP_FRAGMENTATION_V1,
            CAP_BACKPRESSURE_V1,
            CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1,
            CAP_PROVIDER_LEASE_V1,
            "future_browser_cap_v9",
        ),
        limits=_small_limits(fragment_payload_bytes=8, max_logical_bytes=64),
    )
    remote = build_protocol_hello(
        role="consumer",
        capabilities=(
            CAP_FRAGMENTATION_V1,
            CAP_PROVIDER_LEASE_V1,
            CAP_CONSUMER_ONLY_V1,
            "unknown_remote_cap",
        ),
        limits=_small_limits(
            fragment_payload_bytes=4, max_logical_bytes=32, max_peer_aggregate_bytes=96
        ),
    )

    parsed = parse_protocol_hello(remote)
    assert parsed.role == "consumer"
    assert parsed.raw_capabilities[-1] == "unknown_remote_cap"
    assert parsed.capabilities == frozenset(
        {CAP_FRAGMENTATION_V1, CAP_PROVIDER_LEASE_V1, CAP_CONSUMER_ONLY_V1}
    )

    negotiated = negotiate_protocol(local, remote)
    assert negotiated.role == "consumer"
    assert negotiated.supports(CAP_FRAGMENTATION_V1)
    assert negotiated.supports(CAP_PROVIDER_LEASE_V1)
    assert not negotiated.supports(CAP_BACKPRESSURE_V1)
    assert negotiated.limits.fragment_payload_bytes == 4
    assert negotiated.limits.max_logical_bytes == 32
    assert negotiated.limits.max_peer_aggregate_bytes == 96


@pytest.mark.unit
def test_protocol_hello_strict_bounds() -> None:
    with pytest.raises(PeerProtocolError):
        parse_protocol_hello(
            {"type": "protocol_hello", "v": 1, "role": "admin", "capabilities": []}
        )
    with pytest.raises(PeerProtocolError):
        build_protocol_hello(capabilities=("x" * 97,))
    with pytest.raises(PeerProtocolError):
        PeerProtocolLimits(fragment_payload_bytes=32 * 1024)
    with pytest.raises(PeerProtocolError, match="not boolean"):
        parse_protocol_hello(
            {
                "type": "protocol_hello",
                "v": 1,
                "role": "consumer",
                "capabilities": [],
                "limits": {"fragment_payload_bytes": True},
            }
        )


@pytest.mark.unit
def test_provider_lease_parser_accepts_lease_and_tombstone_bounds() -> None:
    lease = parse_provider_lease_frame(
        {
            "type": "provider_lease",
            "peer_id": "peer-a",
            "connection_epoch": "epoch-1",
            "availability_revision": 1.0,
            "issued_at_ms": 1e3,
            "expires_at_ms": 61000.0,
            "available": True,
        }
    )
    assert lease.type == "provider_lease"
    assert lease.availability_revision == 1
    assert lease.issued_at_ms == 1000
    assert lease.is_available is True

    tombstone = parse_provider_lease_frame(
        {
            "type": "provider_unavailable",
            "peer_id": "peer-a",
            "connection_epoch": "epoch-1",
            "availability_revision": 2,
            "issued_at_ms": 61000,
            "expires_at_ms": 61000,
            "available": False,
            "reason_code": "page_hidden",
        }
    )
    assert tombstone.is_available is False
    assert tombstone.reason_code == "page_hidden"


@pytest.mark.unit
def test_provider_lease_parser_rejects_malformed_and_expiry_regression() -> None:
    valid = {
        "type": "provider_lease",
        "peer_id": "peer-a",
        "connection_epoch": "epoch-1",
        "availability_revision": 1,
        "issued_at_ms": 1000,
        "expires_at_ms": 61000,
    }
    for key in ("peer_id", "connection_epoch", "availability_revision", "issued_at_ms"):
        bad = dict(valid)
        bad.pop(key)
        with pytest.raises(PeerProtocolError):
            parse_provider_lease_frame(bad)
    with pytest.raises(PeerProtocolError, match="expires"):
        parse_provider_lease_frame({**valid, "expires_at_ms": 999})
    with pytest.raises(PeerProtocolError):
        parse_provider_lease_frame({**valid, "availability_revision": True})
    with pytest.raises(PeerProtocolError):
        parse_provider_lease_frame({**valid, "availability_revision": 1.5})
    with pytest.raises(PeerProtocolError):
        parse_provider_lease_frame({**valid, "availability_revision": -1})
    with pytest.raises(PeerProtocolError):
        parse_provider_lease_frame({**valid, "availability_revision": 9007199254740992})
    with pytest.raises(PeerProtocolError):
        parse_provider_lease_frame({**valid, "reason_code": "x" * 129})


@pytest.mark.unit
def test_forced_small_fragmentation_and_reordering_reassembles_once() -> None:
    limits = _small_limits(fragment_payload_bytes=5, max_logical_bytes=64)
    message = '{"text":"hello world"}'
    frames = fragment_message(message, message_id="msg-1", limits=limits)
    assert len(frames) > 1
    assert frames[0]["payload_b64"].endswith("=") is False

    reassembler = FragmentReassembler(limits=limits)
    assert reassembler.receive("peer-a", frames[2]) is None
    assert reassembler.receive("peer-a", frames[0]) is None
    completed = None
    for frame in frames[3:] + frames[1:2]:
        completed = reassembler.receive("peer-a", frame)
    assert completed == message
    assert reassembler.receive("peer-a", frames[0]) is None


@pytest.mark.unit
def test_identical_duplicate_is_idempotent_before_completion() -> None:
    limits = _small_limits(fragment_payload_bytes=4)
    frames = fragment_message("abcdefghijk", message_id="dup-ok", limits=limits)
    reassembler = FragmentReassembler(limits=limits)

    assert reassembler.receive("peer-a", frames[0]) is None
    assert reassembler.receive("peer-a", dict(frames[0])) is None
    assert reassembler.receive("peer-a", frames[1]) is None
    assert reassembler.receive("peer-a", frames[2]) == "abcdefghijk"


@pytest.mark.unit
def test_conflicting_duplicate_is_rejected() -> None:
    limits = _small_limits(fragment_payload_bytes=4)
    frames = fragment_message("abcdefgh", message_id="dup-bad", limits=limits)
    bad = dict(frames[0])
    bad["payload_b64"] = "WlpaWg"
    reassembler = FragmentReassembler(limits=limits)

    assert reassembler.receive("peer-a", frames[0]) is None
    with pytest.raises(FragmentProtocolError):
        reassembler.receive("peer-a", bad)
    assert reassembler.incomplete_count("peer-a") == 0


@pytest.mark.unit
def test_bad_hash_is_rejected_and_drops_assembly() -> None:
    limits = _small_limits(fragment_payload_bytes=4)
    frames = fragment_message("abcdefgh", message_id="bad-hash", limits=limits)
    frames = [dict(frame) for frame in frames]
    for frame in frames:
        frame["sha256"] = "0" * 64
    reassembler = FragmentReassembler(limits=limits)

    assert reassembler.receive("peer-a", frames[0]) is None
    with pytest.raises(FragmentProtocolError, match="sha256"):
        reassembler.receive("peer-a", frames[1])
    assert reassembler.incomplete_count("peer-a") == 0


@pytest.mark.unit
def test_malformed_base64_and_oversize_are_rejected() -> None:
    limits = _small_limits(fragment_payload_bytes=4, max_logical_bytes=12)
    with pytest.raises(FragmentProtocolError):
        fragment_message("x" * 13, message_id="oversize", limits=limits)

    frame = fragment_message("abcd", message_id="bad64", limits=limits)[0]
    frame = dict(frame)
    frame["payload_b64"] = "not*base64"
    with pytest.raises(FragmentProtocolError):
        FragmentReassembler(limits=limits).receive("peer-a", frame)


@pytest.mark.unit
def test_per_peer_aggregate_quota_is_enforced() -> None:
    limits = _small_limits(
        fragment_payload_bytes=4, max_logical_bytes=64, max_peer_aggregate_bytes=64
    )
    first = fragment_message("a" * 40, message_id="quota-1", limits=limits)
    second = fragment_message("b" * 40, message_id="quota-2", limits=limits)
    reassembler = FragmentReassembler(limits=limits)

    for frame in first[:8]:
        assert reassembler.receive("peer-a", frame) is None
    for frame in second[:8]:
        assert reassembler.receive("peer-a", frame) is None
    with pytest.raises(FragmentProtocolError, match="quota"):
        reassembler.receive("peer-a", first[8])
    assert reassembler.incomplete_count("peer-a") == 1
    assert reassembler.receive("peer-b", first[8]) is None


@pytest.mark.unit
def test_timeout_expiry_allows_retry() -> None:
    now = 100.0

    def clock() -> float:
        return now

    limits = _small_limits(fragment_payload_bytes=4, incomplete_ttl_seconds=1.0)
    frames = fragment_message("abcdefgh", message_id="expires", limits=limits)
    reassembler = FragmentReassembler(limits=limits, clock=clock)
    assert reassembler.receive("peer-a", frames[0]) is None
    now = 102.0
    assert reassembler.expire() == 1
    assert reassembler.incomplete_count("peer-a") == 0
    assert reassembler.receive("peer-a", frames[0]) is None


@pytest.mark.unit
def test_metadata_conflict_drops_existing_assembly() -> None:
    limits = _small_limits(fragment_payload_bytes=4)
    frames = fragment_message("abcdefgh", message_id="meta-conflict", limits=limits)
    bad = dict(frames[1])
    bad["total_len"] = 12
    reassembler = FragmentReassembler(limits=limits)

    assert reassembler.receive("peer-a", frames[0]) is None
    with pytest.raises(FragmentProtocolError):
        reassembler.receive("peer-a", bad)
    assert reassembler.incomplete_count("peer-a") == 0


@pytest.mark.unit
def test_completed_replay_tombstones_are_ttl_bounded_and_cleanup_scoped() -> None:
    now = 100.0

    def clock() -> float:
        return now

    limits = _small_limits(fragment_payload_bytes=4, incomplete_ttl_seconds=1.0)
    frames = fragment_message("abcdefgh", message_id="done", limits=limits)
    reassembler = FragmentReassembler(limits=limits, clock=clock)
    assert reassembler.receive("peer-a", frames[0]) is None
    assert reassembler.receive("peer-a", frames[1]) == "abcdefgh"
    assert reassembler.completed_count("peer-a") == 1
    assert reassembler.receive("peer-a", frames[0]) is None
    now = 102.0
    assert reassembler.expire() == 1
    assert reassembler.completed_count("peer-a") == 0

    frames_b = fragment_message("abcdefgh", message_id="done-b", limits=limits)
    assert reassembler.receive("peer-b", frames_b[0]) is None
    assert reassembler.receive("peer-b", frames_b[1]) == "abcdefgh"
    assert reassembler.cleanup_peer("peer-b") == 1
    assert reassembler.completed_count("peer-b") == 0


@pytest.mark.unit
def test_peer_isolated_cleanup() -> None:
    limits = _small_limits(fragment_payload_bytes=4)
    peer_a = fragment_message("abcdefgh", message_id="cleanup-a", limits=limits)
    peer_b = fragment_message("abcdefgh", message_id="cleanup-b", limits=limits)
    reassembler = FragmentReassembler(limits=limits)

    assert reassembler.receive("peer-a", peer_a[0]) is None
    assert reassembler.receive("peer-b", peer_b[0]) is None
    assert reassembler.cleanup_peer("peer-a") == 1
    assert reassembler.incomplete_count("peer-a") == 0
    assert reassembler.incomplete_count("peer-b") == 1
    assert reassembler.receive("peer-b", peer_b[1]) == "abcdefgh"
