from __future__ import annotations

import asyncio
import contextlib
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.gateway.webrtc.peer_protocol import (
    CAP_BACKPRESSURE_V1,
    CAP_FRAGMENTATION_V1,
    DEFAULT_PEER_CAPABILITIES,
    FRAGMENT_FRAME_TYPE,
    FragmentReassembler,
    PeerProtocolLimits,
    build_protocol_hello,
    fragment_message,
    negotiate_protocol,
)
from app.services.gateway.webrtc.rtc_client import RTCClient


class FakeDataChannel:
    def __init__(self, *, buffered: int = 0) -> None:
        self.readyState = "open"
        self.bufferedAmount = buffered
        self.bufferedAmountLowThreshold = 0
        self.sent: list[str | bytes] = []
        self.listeners: dict[str, list] = {}

    def send(self, payload):
        self.sent.append(payload)
        if isinstance(payload, bytes):
            self.bufferedAmount += len(payload)
        else:
            self.bufferedAmount += len(payload.encode("utf-8"))

    def on(self, event_name, callback=None):
        if callback is None:

            def decorator(func):
                self.listeners.setdefault(event_name, []).append(func)
                return func

            return decorator
        self.listeners.setdefault(event_name, []).append(callback)
        return callback

    def remove_listener(self, event_name, callback):
        with contextlib.suppress(ValueError):
            self.listeners.get(event_name, []).remove(callback)

    def drain_to(self, amount: int) -> None:
        self.bufferedAmount = amount
        for callback in list(self.listeners.get("bufferedamountlow", [])):
            callback()


def _settings():
    return SimpleNamespace(
        webrtc=SimpleNamespace(
            password="fixture-password",
            app_id="fixture-app",
            room="fixture-room",
            stun_servers=[],
            turn_servers=[],
            enable_app_layer_e2ee=False,
            encrypt_signaling=False,
        )
    )


def _client() -> RTCClient:
    return RTCClient(_settings(), MagicMock(), MagicMock(), AsyncMock(), require_auth=True)


def _small_limits() -> PeerProtocolLimits:
    return PeerProtocolLimits(
        fragment_payload_bytes=8,
        max_logical_bytes=128,
        max_peer_aggregate_bytes=4096,
        incomplete_ttl_seconds=1.0,
        max_fragments=32,
    )


@pytest.mark.unit
def test_peer_protocol_defaults_legacy_to_hybrid_and_no_capabilities() -> None:
    client = _client()

    assert client.peer_protocol_role("missing-peer") == "hybrid"
    assert client.peer_supports_capability("missing-peer", CAP_FRAGMENTATION_V1) is False


@pytest.mark.unit
def test_authenticated_protocol_hello_negotiates_for_session_and_stable_peer() -> None:
    client = _client()
    limits = _small_limits()
    client._local_protocol_hello = build_protocol_hello(  # noqa: SLF001
        role="hybrid", capabilities=DEFAULT_PEER_CAPABILITIES, limits=limits
    )
    client._remember_stable_peer_id("session-peer", "stable-peer", "Remote")  # noqa: SLF001

    client._handle_protocol_hello(  # noqa: SLF001
        "session-peer",
        build_protocol_hello(role="consumer", capabilities=(CAP_FRAGMENTATION_V1,), limits=limits),
    )

    assert client.peer_protocol_role("session-peer") == "consumer"
    assert client.peer_protocol_role("stable-peer") == "consumer"
    assert client.peer_supports_capability("stable-peer", CAP_FRAGMENTATION_V1) is True
    assert client.peer_supports_capability("stable-peer", CAP_BACKPRESSURE_V1) is False


@pytest.mark.unit
def test_fragment_requires_negotiated_authenticated_capability() -> None:
    client = _client()
    frame = fragment_message(
        '{"type":"ping","id":"1"}', message_id="frag-deny", limits=_small_limits()
    )[0]

    assert client._handle_fragment_frame("session-peer", frame) is None  # noqa: SLF001
    assert client._diagnostic_errors[0].code == "fragment_unnegotiated"  # noqa: SLF001


@pytest.mark.unit
def test_out_of_order_fragments_reassemble_once_for_stable_peer() -> None:
    client = _client()
    limits = _small_limits()
    client._remember_stable_peer_id("session-peer", "stable-peer", "Remote")  # noqa: SLF001
    hello = build_protocol_hello(role="hybrid", capabilities=(CAP_FRAGMENTATION_V1,), limits=limits)
    negotiated = negotiate_protocol(hello, hello)
    client._peer_protocols["session-peer"] = negotiated  # noqa: SLF001
    client._peer_protocols["stable-peer"] = negotiated  # noqa: SLF001

    frames = fragment_message(
        '{"type":"ping","id":"1","payload":"hello"}', message_id="msg-1", limits=limits
    )
    assert frames[0]["type"] == FRAGMENT_FRAME_TYPE
    assert client._handle_fragment_frame("session-peer", frames[1]) is None  # noqa: SLF001
    assert client._handle_fragment_frame("session-peer", frames[0]) is None  # noqa: SLF001
    completed = None
    for frame in frames[2:]:
        completed = client._handle_fragment_frame("session-peer", frame)  # noqa: SLF001

    assert completed == '{"type":"ping","id":"1","payload":"hello"}'
    assert client._handle_fragment_frame("session-peer", frames[0]) is None  # noqa: SLF001


@pytest.mark.asyncio
async def test_send_to_peer_async_fragments_with_backpressure_and_rejects_oversize() -> None:
    client = _client()
    limits = _small_limits()
    hello = build_protocol_hello(
        role="hybrid", capabilities=(CAP_FRAGMENTATION_V1, CAP_BACKPRESSURE_V1), limits=limits
    )
    protocol = negotiate_protocol(hello, hello)
    channel = FakeDataChannel()
    client._peer_data_channels["session-peer"] = channel  # noqa: SLF001
    client._peer_protocols["session-peer"] = protocol  # noqa: SLF001

    ok = await client.send_to_peer_async(
        "session-peer", json.dumps({"type": "call", "payload": "x" * 40})
    )

    assert ok is True
    assert len(channel.sent) > 1
    assert all(json.loads(payload)["type"] == FRAGMENT_FRAME_TYPE for payload in channel.sent)

    assert (
        await client.send_to_peer_async(
            "session-peer", "x" * (PeerProtocolLimits().max_logical_bytes + 1)
        )
        is False
    )
    assert client._diagnostic_errors[0].code == "datachannel_payload_oversize"  # noqa: SLF001


@pytest.mark.asyncio
async def test_send_to_peer_async_legacy_sends_small_unfragmented() -> None:
    client = _client()
    channel = FakeDataChannel()
    client._peer_data_channels["legacy-peer"] = channel  # noqa: SLF001

    assert await client.send_to_peer_async("legacy-peer", '{"type":"ping"}') is True
    assert channel.sent == ['{"type":"ping"}']


@pytest.mark.unit
def test_protocol_cleanup_is_scoped_to_disconnected_peer() -> None:
    client = _client()
    limits = _small_limits()
    hello = build_protocol_hello(role="hybrid", capabilities=(CAP_FRAGMENTATION_V1,), limits=limits)
    protocol = negotiate_protocol(hello, hello)
    client._remember_stable_peer_id("session-a", "stable-a", "A")  # noqa: SLF001
    client._remember_stable_peer_id("session-b", "stable-b", "B")  # noqa: SLF001
    for key in ("session-a", "stable-a", "session-b", "stable-b"):
        client._peer_protocols[key] = protocol  # noqa: SLF001
    frame_a = fragment_message("abcdefghi", message_id="cleanup-a", limits=limits)[0]
    frame_b = fragment_message("abcdefghi", message_id="cleanup-b", limits=limits)[0]
    client._fragment_reassemblers["stable-a"] = FragmentReassembler(limits=limits)  # noqa: SLF001
    client._fragment_reassemblers["stable-b"] = FragmentReassembler(limits=limits)  # noqa: SLF001
    client._fragment_reassemblers["stable-a"].receive("stable-a", frame_a)  # noqa: SLF001
    client._fragment_reassemblers["stable-b"].receive("stable-b", frame_b)  # noqa: SLF001

    client._cleanup_peer_protocol_state("session-a", "stable-a")  # noqa: SLF001

    assert "session-a" not in client._peer_protocols  # noqa: SLF001
    assert "stable-a" not in client._peer_protocols  # noqa: SLF001
    assert "session-b" in client._peer_protocols  # noqa: SLF001
    assert "stable-a" not in client._fragment_reassemblers  # noqa: SLF001
    assert client._fragment_reassemblers["stable-b"].incomplete_count("stable-b") == 1  # noqa: SLF001
