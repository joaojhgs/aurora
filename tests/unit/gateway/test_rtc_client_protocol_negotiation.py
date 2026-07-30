from __future__ import annotations

import asyncio
import contextlib
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.gateway.acl.identity import Identity
from app.services.gateway.mesh.negotiation import LEGACY_MANIFEST_PROTOCOL, SUPPORTED_PROTOCOLS
from app.services.gateway.webrtc.peer_protocol import (
    CAP_BACKPRESSURE_V1,
    CAP_FRAGMENTATION_V1,
    CAP_PROVIDER_LEASE_V1,
    DEFAULT_PEER_CAPABILITIES,
    FRAGMENT_FRAME_TYPE,
    FragmentReassembler,
    PeerProtocolLimits,
    build_protocol_hello,
    fragment_message,
    negotiate_protocol,
)
from app.services.gateway.webrtc.rtc_client import RTCClient, _ManifestAckExpectation


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


class FakePeerRegistry:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []
        self.registered: list[tuple[str, str]] = []
        self.required: list[str] = []
        self.updated: list[tuple[str, object]] = []
        self.applied: list[object] = []
        self.expired: list[tuple[str, str, int, int]] = []
        self.removed: list[str] = []
        self.apply_result = True

    async def register_peer(self, peer_id: str, node_name: str = "") -> None:
        self.calls.append(("register_peer", peer_id))
        self.registered.append((peer_id, node_name))

    async def require_provider_lease(self, peer_id: str) -> None:
        self.calls.append(("require_provider_lease", peer_id))
        self.required.append(peer_id)

    async def update_manifest(self, peer_id: str, manifest) -> None:
        self.calls.append(("update_manifest", peer_id))
        self.updated.append((peer_id, manifest))

    def get_peer(self, _peer_id: str):
        return SimpleNamespace(latency_ms=float("inf"))

    async def apply_provider_lease(self, lease, *, now_ms: int) -> bool:
        self.applied.append((lease, now_ms))
        return self.apply_result

    async def expire_provider_lease(
        self,
        peer_id: str,
        *,
        connection_epoch: str,
        availability_revision: int,
        now_ms: int,
    ) -> bool:
        self.expired.append((peer_id, connection_epoch, availability_revision, now_ms))
        return True

    async def remove_peer(self, peer_id: str) -> None:
        self.calls.append(("remove_peer", peer_id))
        self.removed.append(peer_id)


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


def _provider_lease_frame(
    *,
    peer_id: str = "stable-peer",
    epoch: str = "epoch-1",
    revision: int = 1,
    issued_at_ms: int = 1000,
    expires_at_ms: int = 61000,
    frame_type: str = "provider_lease",
    available: bool = True,
) -> dict[str, object]:
    return {
        "type": frame_type,
        "peer_id": peer_id,
        "connection_epoch": epoch,
        "availability_revision": revision,
        "issued_at_ms": issued_at_ms,
        "expires_at_ms": expires_at_ms,
        "available": available,
    }


def _negotiate_provider_lease(client: RTCClient) -> None:
    limits = _small_limits()
    hello = build_protocol_hello(
        role="hybrid",
        capabilities=(CAP_PROVIDER_LEASE_V1, CAP_FRAGMENTATION_V1),
        limits=limits,
    )
    protocol = negotiate_protocol(hello, hello)
    client._remember_stable_peer_id("session-peer", "stable-peer", "Remote")  # noqa: SLF001
    client._peer_protocols["session-peer"] = protocol  # noqa: SLF001
    client._peer_protocols["stable-peer"] = protocol  # noqa: SLF001


def _legacy_manifest_dict(peer_id: str = "stable-peer") -> dict[str, object]:
    return {
        "type": "manifest",
        "peer_id": peer_id,
        "node_name": "Remote",
        "aurora_version": "1.0.0",
        "shared_services": [],
        "active_protocol": LEGACY_MANIFEST_PROTOCOL,
        "active_version": "v0",
        "active_tier": "legacy",
        "supported_protocols": list(SUPPORTED_PROTOCOLS),
        "projection_supported": True,
        "projection_active": False,
        "recipient_projection_evidence": None,
        "timestamp": "2026-07-29T00:00:00+00:00",
    }


def _authenticated_identity() -> Identity:
    return Identity(
        principal_id="peer-user",
        principal_name="peer-user",
        is_admin=False,
        effective_perms=frozenset({"user"}),
        source="webrtc_peer",
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


@pytest.mark.asyncio
async def test_provider_lease_protocol_hello_marks_peer_lease_required() -> None:
    client = _client()
    registry = FakePeerRegistry()
    client._peer_registry = registry  # noqa: SLF001
    client._remember_stable_peer_id("session-peer", "stable-peer", "Remote")  # noqa: SLF001

    client._handle_protocol_hello(  # noqa: SLF001
        "session-peer",
        build_protocol_hello(
            role="hybrid",
            capabilities=(CAP_PROVIDER_LEASE_V1,),
            limits=_small_limits(),
        ),
    )
    await asyncio.sleep(0)

    assert registry.required == ["stable-peer"]


@pytest.mark.asyncio
async def test_provider_lease_manifest_requires_lease_before_manifest_update() -> None:
    client = _client()
    registry = FakePeerRegistry()
    client._peer_registry = registry  # noqa: SLF001
    client._remember_stable_peer_id("session-peer", "stable-peer", "Remote")  # noqa: SLF001
    client._handle_protocol_hello(  # noqa: SLF001
        "session-peer",
        build_protocol_hello(
            role="hybrid",
            capabilities=(CAP_PROVIDER_LEASE_V1,),
            limits=_small_limits(),
        ),
    )
    await asyncio.sleep(0)

    await client._on_peer_manifest("session-peer", _legacy_manifest_dict())  # noqa: SLF001

    assert registry.calls == [
        ("require_provider_lease", "stable-peer"),
        ("register_peer", "stable-peer"),
        ("require_provider_lease", "stable-peer"),
        ("update_manifest", "stable-peer"),
    ]


@pytest.mark.unit
def test_legacy_authenticated_peer_remains_ready_without_provider_lease_capability() -> None:
    client = _client()
    client._remember_stable_peer_id("session-peer", "stable-peer", "Remote")  # noqa: SLF001
    identity = _authenticated_identity()
    client._peer_acl["session-peer"] = identity  # noqa: SLF001
    client._peer_acl["stable-peer"] = identity  # noqa: SLF001
    client._is_peer_session_active = lambda peer_id: peer_id == "session-peer"  # type: ignore[method-assign]  # noqa: SLF001

    assert client.peer_supports_capability("session-peer", CAP_PROVIDER_LEASE_V1) is False
    assert client._is_local_provider_ready_for_session("session-peer") is True  # noqa: SLF001


@pytest.mark.asyncio
async def test_provider_lease_rejects_unnegotiated_malformed_wrong_peer_and_stale_session() -> None:
    client = _client()
    registry = FakePeerRegistry()
    client._peer_registry = registry  # noqa: SLF001
    handler = AsyncMock()

    client._dispatch_authenticated_datachannel_message(  # noqa: SLF001
        peer="session-peer",
        handler=handler,
        text="{}",
        obj=_provider_lease_frame(),
    )
    await asyncio.sleep(0)
    assert client._diagnostic_errors[0].code == "provider_lease_unnegotiated"  # noqa: SLF001

    _negotiate_provider_lease(client)
    client._dispatch_authenticated_datachannel_message(  # noqa: SLF001
        peer="session-peer",
        handler=handler,
        text="{}",
        obj={**_provider_lease_frame(), "expires_at_ms": 999},
    )
    await asyncio.sleep(0)
    assert client._diagnostic_errors[0].code == "provider_lease_malformed"  # noqa: SLF001

    client._dispatch_authenticated_datachannel_message(  # noqa: SLF001
        peer="session-peer",
        handler=handler,
        text="{}",
        obj=_provider_lease_frame(peer_id="other-peer"),
    )
    await asyncio.sleep(0)
    assert client._diagnostic_errors[0].code == "provider_lease_wrong_peer"  # noqa: SLF001

    client._stable_peer_sessions["stable-peer"] = "replacement-session"  # noqa: SLF001
    client._dispatch_authenticated_datachannel_message(  # noqa: SLF001
        peer="session-peer",
        handler=handler,
        text="{}",
        obj=_provider_lease_frame(),
    )
    await asyncio.sleep(0)
    assert client._diagnostic_errors[0].code == "provider_lease_stale_session"  # noqa: SLF001
    assert registry.applied == []
    handler.on_message.assert_not_called()


@pytest.mark.asyncio
async def test_provider_lease_schedules_exact_expiry_and_tombstone_cancels() -> None:
    client = _client()
    registry = FakePeerRegistry()
    client._peer_registry = registry  # noqa: SLF001
    _negotiate_provider_lease(client)
    now_ms = 1000
    sleep_release = asyncio.Event()
    sleeps: list[float] = []

    async def fake_sleep(delay: float) -> None:
        sleeps.append(delay)
        await sleep_release.wait()

    client._provider_lease_clock_ms = lambda: now_ms  # noqa: SLF001
    client._provider_lease_sleep = fake_sleep  # noqa: SLF001

    await client._handle_provider_lease_frame("session-peer", _provider_lease_frame())  # noqa: SLF001
    await asyncio.sleep(0)

    assert sleeps == [60.0]
    assert "stable-peer" in client._provider_lease_tasks  # noqa: SLF001

    now_ms = 61000
    task = client._provider_lease_tasks["stable-peer"][3]  # noqa: SLF001
    sleep_release.set()
    await task

    assert registry.expired == [("stable-peer", "epoch-1", 1, 61000)]

    await client._handle_provider_lease_frame(  # noqa: SLF001
        "session-peer",
        _provider_lease_frame(
            revision=2,
            issued_at_ms=62000,
            expires_at_ms=62000,
            frame_type="provider_unavailable",
            available=False,
        ),
    )

    assert "stable-peer" not in client._provider_lease_tasks  # noqa: SLF001


@pytest.mark.asyncio
async def test_active_provider_lease_releases_one_pending_projection_sync() -> None:
    client = _client()
    registry = FakePeerRegistry()
    client._peer_registry = registry  # noqa: SLF001
    _negotiate_provider_lease(client)
    client._schedule_provider_lease_expiry = MagicMock()  # type: ignore[method-assign]  # noqa: SLF001
    client._request_tooling_projection_sync = AsyncMock()  # type: ignore[method-assign]  # noqa: SLF001
    client._tooling_projection_sync_after_lease.add("stable-peer")  # noqa: SLF001

    await client._handle_provider_lease_frame(  # noqa: SLF001
        "session-peer",
        _provider_lease_frame(),
    )
    await client._handle_provider_lease_frame(  # noqa: SLF001
        "session-peer",
        _provider_lease_frame(revision=2, issued_at_ms=2000, expires_at_ms=62000),
    )

    client._request_tooling_projection_sync.assert_awaited_once_with(  # type: ignore[attr-defined]  # noqa: SLF001
        "stable-peer",
        reason="provider_lease_available",
    )
    assert "stable-peer" not in client._tooling_projection_sync_after_lease  # noqa: SLF001


@pytest.mark.asyncio
async def test_stale_expiry_finalizer_does_not_remove_new_epoch_timer() -> None:
    client = _client()
    registry = FakePeerRegistry()
    client._peer_registry = registry  # noqa: SLF001
    _negotiate_provider_lease(client)
    new_task = asyncio.create_task(asyncio.sleep(60))
    client._provider_lease_tasks["stable-peer"] = (  # noqa: SLF001
        "session-peer",
        "epoch-new",
        1,
        new_task,
    )
    client._provider_lease_clock_ms = lambda: 61000  # noqa: SLF001
    client._provider_lease_sleep = AsyncMock(return_value=None)  # noqa: SLF001

    await client._expire_provider_lease_after(  # noqa: SLF001
        "stable-peer",
        "session-peer",
        "epoch-old",
        1,
        61000,
    )

    assert client._provider_lease_tasks["stable-peer"][1] == "epoch-new"  # noqa: SLF001
    assert registry.expired == [("stable-peer", "epoch-old", 1, 61000)]
    new_task.cancel()
    await asyncio.gather(new_task, return_exceptions=True)


@pytest.mark.asyncio
async def test_provider_lease_renewal_replaces_timer_and_session_replacement_cleans_old() -> None:
    client = _client()
    registry = FakePeerRegistry()
    client._peer_registry = registry  # noqa: SLF001
    _negotiate_provider_lease(client)
    sleep_started = asyncio.Event()

    async def fake_sleep(_delay: float) -> None:
        sleep_started.set()
        await asyncio.Event().wait()

    client._provider_lease_sleep = fake_sleep  # noqa: SLF001

    await client._handle_provider_lease_frame("session-peer", _provider_lease_frame())  # noqa: SLF001
    await sleep_started.wait()
    first_task = client._provider_lease_tasks["stable-peer"][3]  # noqa: SLF001
    await client._handle_provider_lease_frame(  # noqa: SLF001
        "session-peer",
        _provider_lease_frame(revision=2, issued_at_ms=2000, expires_at_ms=62000),
    )
    await asyncio.sleep(0)

    assert first_task.cancelled()
    assert client._provider_lease_tasks["stable-peer"][2] == 2  # noqa: SLF001

    client._remember_stable_peer_id("replacement-session", "stable-peer", "Remote")  # noqa: SLF001

    assert "stable-peer" not in client._provider_lease_tasks  # noqa: SLF001


@pytest.mark.asyncio
async def test_no_pc_signaling_departure_cancels_provider_timer_and_removes_peer() -> None:
    client = _client()
    registry = FakePeerRegistry()
    client._peer_registry = registry  # noqa: SLF001
    client._remember_stable_peer_id("session-peer", "stable-peer", "Remote")  # noqa: SLF001
    task = asyncio.create_task(asyncio.sleep(60))
    client._provider_lease_tasks["stable-peer"] = (  # noqa: SLF001
        "session-peer",
        "epoch-1",
        1,
        task,
    )

    await client._handle_signaling_departure("session-peer", reason="left")  # noqa: SLF001
    await asyncio.gather(task, return_exceptions=True)

    assert "stable-peer" not in client._provider_lease_tasks  # noqa: SLF001
    assert task.cancelled()
    assert registry.removed == ["stable-peer"]


@pytest.mark.asyncio
async def test_structured_manifest_ack_opens_local_provider_lease_and_renews() -> None:
    client = _client()
    _negotiate_provider_lease(client)
    hello = build_protocol_hello(role="hybrid", capabilities=(CAP_PROVIDER_LEASE_V1,))
    protocol = negotiate_protocol(hello, hello)
    client._peer_protocols["session-peer"] = protocol  # noqa: SLF001
    client._peer_protocols["stable-peer"] = protocol  # noqa: SLF001
    channel = FakeDataChannel()
    client._peer_data_channels["session-peer"] = channel  # noqa: SLF001
    client._mesh_peer_id = "local-provider"  # noqa: SLF001
    client._has_authenticated_stable_peer = lambda _peer_id: True  # type: ignore[method-assign]  # noqa: SLF001
    client._peer_registry = MagicMock()  # noqa: SLF001
    client._peer_registry.update_manifest_ack = AsyncMock()  # noqa: SLF001
    sleep_release = asyncio.Event()
    sleeps: list[float] = []

    async def fake_sleep(delay: float) -> None:
        sleeps.append(delay)
        await sleep_release.wait()

    client._provider_lease_clock_ms = lambda: 1000  # noqa: SLF001
    client._provider_lease_sleep = fake_sleep  # noqa: SLF001
    client._manifest_ack_expectations["stable-peer"] = _ManifestAckExpectation(  # noqa: SLF001
        session_peer_id="session-peer",
        connection_epoch="local-epoch-1",
        projection_digest="projection-digest",
        active_protocol="projection-v1",
        active_version="v1",
        active_tier="projection",
        protocol_revision="v1",
        registry_revision="registry-1",
        export_policy_revision="policy-1",
        auth_grant_revision=7,
        advertised_services=("TTS",),
        compatible_services=(),
    )

    await client._on_manifest_ack(  # noqa: SLF001
        "session-peer",
        {
            "type": "manifest_ack",
            "compatible_services": ["TTS"],
            "incompatible_services": [],
            "unused_services": [],
            "active_protocol": "projection-v1",
            "active_version": "v1",
            "active_tier": "projection",
            "protocol_revision": "v1",
            "registry_revision": "registry-1",
            "export_policy_revision": "policy-1",
            "auth_grant_revision": 7,
            "projection_digest": "projection-digest",
            "services": [
                {"service_id": "TTS", "status": "compatible", "reason_codes": []},
            ],
        },
    )
    await asyncio.sleep(0)

    assert client._is_local_provider_ready_for_session("session-peer") is True  # noqa: SLF001
    first_lease = json.loads(channel.sent[0])
    assert first_lease["type"] == "provider_lease"
    assert first_lease["peer_id"] == "local-provider"
    assert first_lease["connection_epoch"] == "local-epoch-1"
    assert first_lease["availability_revision"] == 1
    assert first_lease["expires_at_ms"] - first_lease["issued_at_ms"] == 60_000
    assert sleeps == [20.0]

    sleep_release.set()
    await asyncio.sleep(0)
    renewal_task = client._local_provider_lease_tasks["stable-peer"][3]  # noqa: SLF001
    renewal_task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await renewal_task


@pytest.mark.asyncio
async def test_stale_bare_or_incompatible_manifest_ack_does_not_open_local_provider() -> None:
    client = _client()
    _negotiate_provider_lease(client)
    hello = build_protocol_hello(role="hybrid", capabilities=(CAP_PROVIDER_LEASE_V1,))
    protocol = negotiate_protocol(hello, hello)
    client._peer_protocols["session-peer"] = protocol  # noqa: SLF001
    client._peer_protocols["stable-peer"] = protocol  # noqa: SLF001
    channel = FakeDataChannel()
    client._peer_data_channels["session-peer"] = channel  # noqa: SLF001
    client._mesh_peer_id = "local-provider"  # noqa: SLF001
    client._has_authenticated_stable_peer = lambda _peer_id: True  # type: ignore[method-assign]  # noqa: SLF001
    client._peer_registry = MagicMock()  # noqa: SLF001
    client._peer_registry.update_manifest_ack = AsyncMock()  # noqa: SLF001
    client._manifest_ack_expectations["stable-peer"] = _ManifestAckExpectation(  # noqa: SLF001
        session_peer_id="session-peer",
        connection_epoch="local-epoch-1",
        projection_digest="projection-digest",
        active_protocol="projection-v1",
        active_version="v1",
        active_tier="projection",
        protocol_revision="v1",
        registry_revision="registry-1",
        export_policy_revision="policy-1",
        auth_grant_revision=7,
        advertised_services=("TTS",),
        compatible_services=(),
    )

    await client._on_manifest_ack(  # noqa: SLF001
        "session-peer",
        {"type": "manifest_ack", "compatible_services": ["TTS"], "protocol_revision": "v1"},
    )
    assert channel.sent == []
    assert client._is_local_provider_ready_for_session("session-peer") is False  # noqa: SLF001

    await client._on_manifest_ack(  # noqa: SLF001
        "session-peer",
        {
            "type": "manifest_ack",
            "compatible_services": [],
            "incompatible_services": ["TTS"],
            "unused_services": [],
            "active_protocol": "projection-v1",
            "active_version": "v1",
            "active_tier": "projection",
            "protocol_revision": "v1",
            "registry_revision": "registry-1",
            "export_policy_revision": "policy-1",
            "auth_grant_revision": 7,
            "projection_digest": "projection-digest",
            "services": [
                {
                    "service_id": "TTS",
                    "status": "incompatible",
                    "reason_codes": ["method_not_advertised"],
                },
            ],
        },
    )

    assert channel.sent == []
    assert client._is_local_provider_ready_for_session("session-peer") is False  # noqa: SLF001


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


@pytest.mark.asyncio
async def test_scheduled_rpc_response_uses_fragmented_ordered_send_path() -> None:
    client = _client()
    limits = _small_limits()
    hello = build_protocol_hello(
        role="hybrid", capabilities=(CAP_FRAGMENTATION_V1, CAP_BACKPRESSURE_V1), limits=limits
    )
    client._peer_protocols["session-peer"] = negotiate_protocol(hello, hello)  # noqa: SLF001
    channel = FakeDataChannel()
    client._peer_data_channels["session-peer"] = channel  # noqa: SLF001

    client._schedule_rpc_send(  # noqa: SLF001
        "session-peer",
        json.dumps({"type": "result", "id": "large-rpc", "result": "x" * 40}),
    )
    tasks = list(client._rpc_send_tasks)  # noqa: SLF001
    await asyncio.gather(*tasks)

    assert len(channel.sent) > 1
    assert all(json.loads(payload)["type"] == FRAGMENT_FRAME_TYPE for payload in channel.sent)
    assert not client._rpc_send_tasks  # noqa: SLF001


@pytest.mark.asyncio
async def test_scheduled_ack_reserves_fifo_before_awaited_event_send() -> None:
    client = _client()
    ack_started = asyncio.Event()
    release_ack = asyncio.Event()
    completed: list[str] = []

    async def delayed_send(_peer_id: str, text: str) -> bool:
        if text == "subscription-ack":
            ack_started.set()
            await release_ack.wait()
        completed.append(text)
        return True

    client._send_to_peer_now = delayed_send  # type: ignore[method-assign]  # noqa: SLF001

    client._schedule_rpc_send("session-peer", "subscription-ack")  # noqa: SLF001
    event_send = asyncio.create_task(client.send_to_peer_async("session-peer", "scoped-event"))
    await ack_started.wait()
    await asyncio.sleep(0)

    assert completed == []
    assert not event_send.done()

    release_ack.set()
    assert await event_send is True
    await asyncio.gather(*list(client._rpc_send_tasks))  # noqa: SLF001

    assert completed == ["subscription-ack", "scoped-event"]


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
