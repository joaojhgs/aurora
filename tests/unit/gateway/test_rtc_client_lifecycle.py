"""Unit tests for RTCClient peer lifecycle management methods."""

from __future__ import annotations

import asyncio
import contextlib
import json
from collections import deque
from datetime import datetime, timedelta
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.messaging.bus import QueryResult
from app.services.db.models import Token, User
from app.services.gateway.acl.identity import ANONYMOUS, Identity
from app.services.gateway.config import MeshConfig
from app.services.gateway.mesh.policy_store import MeshPolicyStore
from app.services.gateway.utils.crypto import aead_open
from app.services.gateway.webrtc.rpc import RPCHandler
from app.services.gateway.webrtc.rtc_client import (
    RTCClient,
    _LocalProviderUnavailableQueue,
    _ManifestAckExpectation,
)
from app.shared.contracts.models.gateway import MethodInfo, ServiceAnnouncement


@pytest.fixture
def mock_deps():
    settings = MagicMock()
    settings.webrtc.password = "test-password"
    settings.webrtc.app_id = "test-app"
    settings.webrtc.room = "test-room"
    settings.webrtc.stun_servers = ["stun:stun.l.google.com:19302"]
    settings.webrtc.turn_servers = []
    settings.webrtc.enable_app_layer_e2ee = False

    bus = MagicMock()
    registry = MagicMock()
    auth_service = AsyncMock()
    auth_service.get_system_token.return_value = "system-token"
    auth_service.db_manager = AsyncMock()
    auth_service.db_manager.store_audit_event = AsyncMock()

    return settings, bus, registry, auth_service


@pytest.fixture
def client(mock_deps):
    settings, bus, registry, auth_service = mock_deps
    return RTCClient(settings, bus, registry, auth_service)


def _make_token(
    user_id: str = "user-1",
    scopes: list[str] | None = None,
) -> Token:
    return Token(
        id="tok-1",
        token_hash="hash",
        prefix="aaaa",
        device_id=None,
        user_id=user_id,
        scopes=scopes or ["*"],
        expires_at=datetime.now() + timedelta(days=365),
    )


def _make_identity(
    principal_id: str = "user-1",
    perms: list[str] | None = None,
    is_admin: bool = False,
) -> Identity:
    return Identity(
        principal_id=principal_id,
        principal_name=f"name-{principal_id}",
        is_admin=is_admin,
        permissions=frozenset(perms or ["TTS.*"]),
        effective_perms=frozenset(perms or ["TTS.*"]),
        source="webrtc_peer",
    )


def _provider_expectation(
    session_peer_id: str = "peer-a",
    *,
    connection_epoch: str = "local-epoch-1",
) -> _ManifestAckExpectation:
    return _ManifestAckExpectation(
        session_peer_id=session_peer_id,
        connection_epoch=connection_epoch,
        projection_digest="projection-digest",
        active_protocol="projection-v1",
        active_version="v1",
        active_tier="projection",
        protocol_revision="v1",
        registry_revision="registry-1",
        export_policy_revision="policy-1",
        auth_grant_revision=1,
        advertised_services=("TTS",),
        compatible_services=("TTS",),
    )


async def _drain_provider_unavailable(client: RTCClient) -> None:
    tasks = [queue.task for queue in client._local_provider_unavailable_tasks.values()]  # noqa: SLF001
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
        await asyncio.sleep(0)


async def _start_blocked_rtc_rpc(
    client: RTCClient,
    peer_id: str,
    stable_peer_id: str | None = None,
) -> tuple[
    asyncio.Task[None], asyncio.Event, asyncio.Event, dict[str, bool], RPCHandler, MagicMock
]:
    started = asyncio.Event()
    cancelled = asyncio.Event()
    state = {"completed": False}
    bus = AsyncMock()

    async def request(*args, **kwargs):
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise
        state["completed"] = True
        return QueryResult(ok=True, data={"ok": True})

    bus.request.side_effect = request
    registry = AsyncMock()
    registry.get_service.return_value = ServiceAnnouncement(
        module="Svc",
        version="1.0",
        methods=[MethodInfo(name="Slow", bus_topic="Svc.Slow", exposure="external")],
    )
    identity = _make_identity(perms=["Svc.Slow"])
    client._peer_acl[peer_id] = identity  # noqa: SLF001
    if stable_peer_id is not None:
        client._peer_acl[stable_peer_id] = identity  # noqa: SLF001
    send = MagicMock()
    handler = RPCHandler(bus, registry, send, lambda: client._peer_acl[peer_id])  # noqa: SLF001
    client._rpc_handlers[peer_id] = handler  # noqa: SLF001
    if stable_peer_id is not None:
        client._rpc_handlers[stable_peer_id] = handler  # noqa: SLF001
    task = asyncio.create_task(
        handler.on_message(json.dumps({"type": "call", "id": "slow-1", "method": "Svc.Slow"}))
    )
    await started.wait()
    return task, started, cancelled, state, handler, send


# ── get_connected_peers ──────────────────────────────────────────────────


def test_get_connected_peers_empty(client):
    assert client.get_connected_peers() == []


def test_get_connected_peers_with_peers(client):
    pc1 = MagicMock()
    pc1.connectionState = "connected"
    pc2 = MagicMock()
    pc2.connectionState = "connected"

    identity1 = _make_identity("user-1", ["TTS.*"])
    identity2 = _make_identity("user-2", ["STT.*"], is_admin=True)

    client._pcs = {"peer-a": pc1, "peer-b": pc2}
    client._peer_acl = {"peer-a": identity1, "peer-b": identity2}

    peers = client.get_connected_peers()
    assert len(peers) == 2
    names = {p["principal_name"] for p in peers}
    assert "name-user-1" in names
    assert "name-user-2" in names

    admin_peer = next(p for p in peers if p["principal_name"] == "name-user-2")
    assert admin_peer["is_admin"] is True


def test_get_connected_peers_anonymous(client):
    """Unauthenticated peer → shows as ANONYMOUS."""
    pc = MagicMock()
    pc.connectionState = "connecting"
    client._pcs = {"peer-x": pc}
    client._peer_acl = {"peer-x": ANONYMOUS}

    peers = client.get_connected_peers()
    assert len(peers) == 1
    assert peers[0]["principal_name"] == "anonymous"
    assert peers[0]["effective_perms"] == []


def test_outbound_ice_filter_is_default_off(mock_deps):
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service)
    sdp = (
        "v=0\r\n"
        "a=candidate:1 1 udp 1 192.0.2.10 5000 typ host\r\n"
        "a=candidate:2 1 udp 1 198.51.100.10 6000 typ srflx\r\n"
    )

    assert client._filter_outbound_session_description(sdp) == sdp


def test_outbound_ice_filter_removes_only_disallowed_candidate_lines(mock_deps):
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(
        settings,
        bus,
        registry,
        auth_service,
        outbound_ice_candidate_allowed=lambda candidate: " typ host" not in candidate,
    )
    sdp = (
        "v=0\r\n"
        "a=mid:0\r\n"
        "a=candidate:1 1 udp 1 192.0.2.10 5000 typ host\r\n"
        "a=candidate:2 1 udp 1 198.51.100.10 6000 typ srflx\r\n"
        "a=end-of-candidates\r\n"
    )

    assert client._filter_outbound_session_description(sdp) == (
        "v=0\r\n"
        "a=mid:0\r\n"
        "a=candidate:2 1 udp 1 198.51.100.10 6000 typ srflx\r\n"
        "a=end-of-candidates\r\n"
    )


@pytest.mark.asyncio
async def test_peer_close_cancels_aioice_retry_work_before_transport_close(client):
    blocked = asyncio.create_task(asyncio.Event().wait())
    timeout_handle = MagicMock()
    transaction_future = asyncio.get_running_loop().create_future()
    transaction = SimpleNamespace(
        _Transaction__timeout_handle=timeout_handle,
        _Transaction__future=transaction_future,
    )
    protocol = SimpleNamespace(transactions={b"transaction": transaction})
    connection = SimpleNamespace(
        _check_list=[SimpleNamespace(task=blocked)],
        _protocols=[protocol],
    )
    ice_transport = SimpleNamespace(_connection=connection)
    pc = SimpleNamespace(
        _RTCPeerConnection__iceTransports=[ice_transport],
        close=AsyncMock(),
    )

    await client._close_peer_connection(pc)  # noqa: SLF001

    assert blocked.cancelled()
    timeout_handle.cancel.assert_called_once_with()
    assert transaction_future.cancelled()
    pc.close.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_outbound_ice_filter_applies_to_sdp_and_trickle_candidates(mock_deps):
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(
        settings,
        bus,
        registry,
        auth_service,
        outbound_ice_candidate_allowed=lambda candidate: " typ host" not in candidate,
    )
    client._adapter = MagicMock()
    client._adapter.send = AsyncMock()
    client._start_negotiation_watchdog = MagicMock()
    peer = "remote-peer"
    pc = MagicMock()
    pc.connectionState = "new"
    pc.createDataChannel.return_value = MagicMock(label="aurora-rpc", readyState="connecting")
    pc.createOffer = AsyncMock(return_value=MagicMock(type="offer", sdp="unfiltered-offer"))
    pc.setLocalDescription = AsyncMock()
    pc.close = AsyncMock()
    pc.localDescription = MagicMock(
        sdp=(
            "v=0\r\n"
            "a=candidate:1 1 udp 1 192.0.2.10 5000 typ host\r\n"
            "a=candidate:2 1 udp 1 198.51.100.10 6000 typ srflx\r\n"
        )
    )
    handlers: dict[str, Any] = {}

    def on(event_name):
        def decorator(callback):
            handlers[event_name] = callback
            return callback

        return decorator

    pc.on = on

    with patch(
        "app.services.gateway.webrtc.rtc_client.RTCPeerConnection",
        return_value=pc,
    ):
        await client.connect_to(peer)

    client._adapter.send.assert_awaited_once()
    channel, sealed = client._adapter.send.await_args.args
    offer = aead_open(client._keys.k_sig, sealed)
    assert channel == "offer"
    assert " typ host" not in offer["sdp"]
    assert " typ srflx" in offer["sdp"]
    assert client._pairing_transports[peer]["offer_sdp"] == offer["sdp"]

    client._adapter.send.reset_mock()
    host_candidate = MagicMock()
    host_candidate.to_sdp.return_value = "candidate:1 1 udp 1 192.0.2.10 5000 typ host"
    await handlers["icecandidate"](MagicMock(candidate=host_candidate))
    client._adapter.send.assert_not_awaited()

    reflexive_candidate = MagicMock()
    reflexive_candidate.to_sdp.return_value = "candidate:2 1 udp 1 198.51.100.10 6000 typ srflx"
    await handlers["icecandidate"](MagicMock(candidate=reflexive_candidate))
    client._adapter.send.assert_awaited_once()
    candidate_channel, candidate_sealed = client._adapter.send.await_args.args
    candidate = aead_open(client._keys.k_sig, candidate_sealed)
    assert candidate_channel == "candidate"
    assert candidate["candidate"].endswith("typ srflx")


# ── disconnect_peer ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_disconnect_peer_success(client):
    pc = AsyncMock()
    pc.connectionState = "connected"
    identity = _make_identity("user-1")
    token = _make_token("user-1", ["TTS.*"])
    timeout_task = MagicMock()
    timeout_task.cancel = MagicMock()
    channel = MagicMock()
    channel.readyState = "open"
    channel.sent = []
    channel.send.side_effect = channel.sent.append

    client._pcs = {"peer-a": pc}
    client._peer_acl = {"peer-a": identity}
    client._peer_tokens = {"peer-a": token}
    client._peer_timeout_tasks = {"peer-a": timeout_task}
    client._mesh_peer_id = "local-provider"
    client._remember_stable_peer_id("peer-a", "stable-peer-a", "remote")
    client._peer_data_channels["peer-a"] = channel
    client._local_provider_ready["stable-peer-a"] = _provider_expectation("peer-a")
    client._peer_registry = MagicMock()
    client._peer_registry.remove_peer = AsyncMock()

    result = await client.disconnect_peer("peer-a", by_principal_id="admin")
    assert result is True
    assert "peer-a" not in client._pcs
    assert "peer-a" not in client._peer_acl
    assert "peer-a" not in client._peer_tokens
    assert "peer-a" not in client._peer_timeout_tasks
    client._peer_registry.remove_peer.assert_awaited_once_with("stable-peer-a")
    tombstone = json.loads(channel.sent[0])
    assert tombstone["type"] == "provider_unavailable"
    assert tombstone["peer_id"] == "local-provider"
    assert tombstone["connection_epoch"] == "local-epoch-1"
    pc.close.assert_called_once()
    timeout_task.cancel.assert_called_once()


@pytest.mark.asyncio
async def test_provider_export_peer_invalidation_sends_snapshot_tombstone_before_reset(client):
    client._mesh_peer_id = "local-provider"
    client._stable_peer_sessions["stable-peer-a"] = "peer-a"
    client._peer_stable_ids["peer-a"] = "stable-peer-a"
    client._local_provider_ready["stable-peer-a"] = _provider_expectation(
        "peer-a",
        connection_epoch="epoch-before-reset",
    )
    client._local_provider_lease_revisions["stable-peer-a"] = 4
    client._is_peer_session_active = MagicMock(return_value=True)  # type: ignore[method-assign]  # noqa: SLF001
    client.send_to_peer_async = AsyncMock(return_value=True)  # type: ignore[method-assign]

    client._invalidate_provider_export_peer("stable-peer-a")  # noqa: SLF001
    assert "stable-peer-a" not in client._local_provider_ready  # noqa: SLF001

    await _drain_provider_unavailable(client)

    client.send_to_peer_async.assert_awaited_once()
    peer_id, wire = client.send_to_peer_async.await_args.args
    tombstone = json.loads(wire)
    assert peer_id == "peer-a"
    assert tombstone["type"] == "provider_unavailable"
    assert tombstone["connection_epoch"] == "epoch-before-reset"
    assert tombstone["availability_revision"] == 5
    assert tombstone["reason_code"] == "provider_export_invalidated"
    assert client._local_provider_unavailable_tasks == {}  # noqa: SLF001


@pytest.mark.asyncio
@pytest.mark.parametrize("trigger", ["direct", "config", "registry"])
async def test_provider_export_all_invalidation_coalesces_per_peer_tombstone_task(
    client,
    trigger: str,
):
    client._mesh_peer_id = "local-provider"
    client._stable_peer_sessions["stable-peer-a"] = "peer-a"
    client._peer_stable_ids["peer-a"] = "stable-peer-a"
    client._local_provider_ready["stable-peer-a"] = _provider_expectation("peer-a")
    client._is_peer_session_active = MagicMock(return_value=True)  # type: ignore[method-assign]  # noqa: SLF001
    started = asyncio.Event()
    release = asyncio.Event()

    async def send_when_released(_peer_id: str, _wire: str) -> bool:
        started.set()
        await release.wait()
        return True

    client.send_to_peer_async = AsyncMock(side_effect=send_when_released)  # type: ignore[method-assign]

    if trigger == "config":
        client.update_mesh_config(MeshConfig(enabled=True))
    elif trigger == "registry":
        client._invalidate_provider_export_registry()  # noqa: SLF001
    else:
        client._invalidate_provider_export_all()  # noqa: SLF001
    await asyncio.wait_for(started.wait(), timeout=1.0)
    client._invalidate_provider_export_all()  # noqa: SLF001
    release.set()
    await _drain_provider_unavailable(client)

    client.send_to_peer_async.assert_awaited_once()


@pytest.mark.asyncio
async def test_provider_unavailable_queue_preserves_new_epoch_after_blocked_old_send(client):
    client._mesh_peer_id = "local-provider"
    client._stable_peer_sessions["stable-peer-a"] = "old-session"
    client._peer_stable_ids["old-session"] = "stable-peer-a"
    client._local_provider_ready["stable-peer-a"] = _provider_expectation(
        "old-session",
        connection_epoch="old-epoch",
    )
    client._is_peer_session_active = MagicMock(return_value=True)  # type: ignore[method-assign]  # noqa: SLF001
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    sent: list[tuple[str, dict[str, object]]] = []

    async def send_with_blocked_first(peer_id: str, wire: str) -> bool:
        sent.append((peer_id, json.loads(wire)))
        if len(sent) == 1:
            first_started.set()
            await release_first.wait()
        return True

    client.send_to_peer_async = AsyncMock(side_effect=send_with_blocked_first)  # type: ignore[method-assign]

    client._invalidate_provider_export_all()  # noqa: SLF001
    await asyncio.wait_for(first_started.wait(), timeout=1.0)

    client._stable_peer_sessions["stable-peer-a"] = "new-session"
    client._peer_stable_ids["new-session"] = "stable-peer-a"
    client._local_provider_ready["stable-peer-a"] = _provider_expectation(
        "new-session",
        connection_epoch="new-epoch",
    )
    client._invalidate_provider_export_all()  # noqa: SLF001

    release_first.set()
    await _drain_provider_unavailable(client)

    assert [peer_id for peer_id, _payload in sent] == ["old-session", "new-session"]
    assert [payload["connection_epoch"] for _peer_id, payload in sent] == [
        "old-epoch",
        "new-epoch",
    ]
    assert [payload["availability_revision"] for _peer_id, payload in sent] == [1, 2]
    assert all(
        payload["reason_code"] == "provider_export_invalidated" for _peer_id, payload in sent
    )
    assert client._local_provider_unavailable_tasks == {}  # noqa: SLF001


@pytest.mark.asyncio
async def test_provider_unavailable_restart_survives_stale_done_callback(client):
    client._mesh_peer_id = "local-provider"
    client._stable_peer_sessions["stable-peer-a"] = "peer-a"
    client._peer_stable_ids["peer-a"] = "stable-peer-a"
    client._local_provider_ready["stable-peer-a"] = _provider_expectation("peer-a")
    client._is_peer_session_active = MagicMock(return_value=True)  # type: ignore[method-assign]  # noqa: SLF001
    started = asyncio.Event()
    release = asyncio.Event()

    async def send_when_released(_peer_id: str, _wire: str) -> bool:
        started.set()
        await release.wait()
        return True

    completed_task = asyncio.create_task(asyncio.sleep(0))
    await completed_task
    client._local_provider_unavailable_tasks["stable-peer-a"] = (  # noqa: SLF001
        _LocalProviderUnavailableQueue(deque(), completed_task)
    )
    client.send_to_peer_async = AsyncMock(side_effect=send_when_released)  # type: ignore[method-assign]

    assert client._schedule_local_provider_unavailable(  # noqa: SLF001
        "stable-peer-a",
        reason_code="provider_export_invalidated",
    )
    replacement = client._local_provider_unavailable_tasks["stable-peer-a"].task  # noqa: SLF001
    assert replacement is not completed_task
    await asyncio.wait_for(started.wait(), timeout=1.0)

    client._local_provider_unavailable_done("stable-peer-a", completed_task)  # noqa: SLF001

    assert client._local_provider_unavailable_tasks["stable-peer-a"].task is replacement  # noqa: SLF001
    release.set()
    await _drain_provider_unavailable(client)

    client.send_to_peer_async.assert_awaited_once()
    assert client._local_provider_unavailable_tasks == {}  # noqa: SLF001


@pytest.mark.asyncio
async def test_provider_unavailable_queue_continues_after_old_send_failure(client):
    client._mesh_peer_id = "local-provider"
    client._stable_peer_sessions["stable-peer-a"] = "old-session"
    client._peer_stable_ids["old-session"] = "stable-peer-a"
    client._local_provider_ready["stable-peer-a"] = _provider_expectation(
        "old-session",
        connection_epoch="old-epoch",
    )
    client._is_peer_session_active = MagicMock(return_value=True)  # type: ignore[method-assign]  # noqa: SLF001
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    sent: list[tuple[str, dict[str, object]]] = []

    async def send_with_failed_first(peer_id: str, wire: str) -> bool:
        sent.append((peer_id, json.loads(wire)))
        if len(sent) == 1:
            first_started.set()
            await release_first.wait()
            raise RuntimeError("old session send failed")
        return True

    client.send_to_peer_async = AsyncMock(side_effect=send_with_failed_first)  # type: ignore[method-assign]

    client._invalidate_provider_export_all()  # noqa: SLF001
    await asyncio.wait_for(first_started.wait(), timeout=1.0)

    client._stable_peer_sessions["stable-peer-a"] = "new-session"
    client._peer_stable_ids["new-session"] = "stable-peer-a"
    client._local_provider_ready["stable-peer-a"] = _provider_expectation(
        "new-session",
        connection_epoch="new-epoch",
    )
    client._invalidate_provider_export_all()  # noqa: SLF001

    release_first.set()
    await _drain_provider_unavailable(client)

    assert [peer_id for peer_id, _payload in sent] == ["old-session", "new-session"]
    assert [payload["connection_epoch"] for _peer_id, payload in sent] == [
        "old-epoch",
        "new-epoch",
    ]
    assert [payload["availability_revision"] for _peer_id, payload in sent] == [1, 2]
    assert client._diagnostic_errors[-1].code == "provider_unavailable_send_failed"  # noqa: SLF001
    assert client._local_provider_unavailable_tasks == {}  # noqa: SLF001


@pytest.mark.asyncio
async def test_provider_unavailable_queue_preserves_new_revision_for_same_epoch(client):
    client._mesh_peer_id = "local-provider"
    client._stable_peer_sessions["stable-peer-a"] = "peer-a"
    client._peer_stable_ids["peer-a"] = "stable-peer-a"
    client._local_provider_ready["stable-peer-a"] = _provider_expectation(
        "peer-a",
        connection_epoch="same-epoch",
    )
    client._local_provider_lease_revisions["stable-peer-a"] = 3
    client._is_peer_session_active = MagicMock(return_value=True)  # type: ignore[method-assign]  # noqa: SLF001
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    sent: list[tuple[str, dict[str, object]]] = []

    async def send_with_blocked_first(peer_id: str, wire: str) -> bool:
        sent.append((peer_id, json.loads(wire)))
        if len(sent) == 1:
            first_started.set()
            await release_first.wait()
        return True

    client.send_to_peer_async = AsyncMock(side_effect=send_with_blocked_first)  # type: ignore[method-assign]

    client._invalidate_provider_export_all()  # noqa: SLF001
    await asyncio.wait_for(first_started.wait(), timeout=1.0)

    client._local_provider_ready["stable-peer-a"] = _provider_expectation(
        "peer-a",
        connection_epoch="same-epoch",
    )
    client._local_provider_lease_revisions["stable-peer-a"] = 5
    client._invalidate_provider_export_all()  # noqa: SLF001

    release_first.set()
    await _drain_provider_unavailable(client)

    assert [peer_id for peer_id, _payload in sent] == ["peer-a", "peer-a"]
    assert [payload["connection_epoch"] for _peer_id, payload in sent] == [
        "same-epoch",
        "same-epoch",
    ]
    assert [payload["availability_revision"] for _peer_id, payload in sent] == [4, 6]
    assert client._local_provider_unavailable_tasks == {}  # noqa: SLF001


@pytest.mark.asyncio
async def test_registry_invalidation_sends_unavailable_before_refresh_reannounce(client):
    client._mesh_peer_id = "local-provider"
    client._stable_peer_sessions["stable-peer-a"] = "peer-a"
    client._peer_stable_ids["peer-a"] = "stable-peer-a"
    client._local_provider_ready["stable-peer-a"] = _provider_expectation("peer-a")
    client._is_peer_session_active = MagicMock(return_value=True)  # type: ignore[method-assign]  # noqa: SLF001
    events: list[str] = []

    async def send_unavailable(_peer_id: str, _wire: str) -> bool:
        events.append("unavailable")
        return True

    async def reannounce(_peer_id: str) -> bool:
        events.append("reannounce")
        return True

    client.send_to_peer_async = AsyncMock(side_effect=send_unavailable)  # type: ignore[method-assign]
    client.reannounce_manifest_for_peer = AsyncMock(side_effect=reannounce)  # type: ignore[method-assign]
    client._peer_registry = MagicMock()  # noqa: SLF001
    client._peer_registry.get_negotiated_peers.return_value = [
        SimpleNamespace(peer_id="stable-peer-a")
    ]

    client._invalidate_provider_export_registry()  # noqa: SLF001
    refresh_tasks = list(client._tooling_projection_refresh_tasks.values())  # noqa: SLF001
    assert refresh_tasks
    await asyncio.gather(*refresh_tasks, return_exceptions=True)

    assert events == ["unavailable", "reannounce"]


@pytest.mark.asyncio
async def test_replaced_stable_session_sends_old_session_tombstone_before_reset(client):
    client._mesh_peer_id = "local-provider"
    client._stable_peer_sessions["stable-peer-a"] = "old-session"
    client._peer_stable_ids["old-session"] = "stable-peer-a"
    client._local_provider_ready["stable-peer-a"] = _provider_expectation(
        "old-session",
        connection_epoch="old-epoch",
    )
    client._is_peer_session_active = MagicMock(return_value=True)  # type: ignore[method-assign]  # noqa: SLF001
    client.send_to_peer_async = AsyncMock(return_value=True)  # type: ignore[method-assign]

    client._remember_stable_peer_id("new-session", "stable-peer-a")  # noqa: SLF001
    await _drain_provider_unavailable(client)

    client.send_to_peer_async.assert_awaited_once()
    peer_id, wire = client.send_to_peer_async.await_args.args
    tombstone = json.loads(wire)
    assert peer_id == "old-session"
    assert tombstone["connection_epoch"] == "old-epoch"
    assert tombstone["reason_code"] == "session_replaced"
    assert client._stable_peer_sessions["stable-peer-a"] == "new-session"  # noqa: SLF001
    assert "stable-peer-a" not in client._local_provider_ready  # noqa: SLF001


@pytest.mark.asyncio
async def test_disconnect_peer_cancels_active_inbound_rpc_work(client):
    pc = AsyncMock()
    pc.connectionState = "connected"
    client._pcs["peer-a"] = pc
    client._peer_data_channels["peer-a"] = MagicMock(readyState="open")
    client._audit = AsyncMock()
    active, _started, cancelled, state, handler, send = await _start_blocked_rtc_rpc(
        client, "peer-a"
    )

    await handler.on_message(json.dumps({"type": "call", "id": "slow-1", "method": "Svc.Slow"}))
    duplicate_response = json.loads(send.call_args.args[0])
    assert duplicate_response["type"] == "error"
    assert duplicate_response["error"]["code"] == 409

    assert await client.disconnect_peer("peer-a", by_principal_id="admin") is True

    with contextlib.suppress(asyncio.CancelledError):
        await active
    assert cancelled.is_set()
    assert state["completed"] is False


@pytest.mark.asyncio
async def test_disconnect_peer_not_found(client):
    result = await client.disconnect_peer("nonexistent")
    assert result is False


@pytest.mark.asyncio
async def test_authority_revocation_cancels_active_inbound_rpc_work(client):
    pc = AsyncMock()
    pc.connectionState = "connected"
    client._pcs["peer-a"] = pc
    client._peer_data_channels["peer-a"] = MagicMock(readyState="open")
    client._remember_stable_peer_id("peer-a", "stable-peer-a", "remote")
    active, _started, cancelled, state, handler, send = await _start_blocked_rtc_rpc(
        client,
        "peer-a",
        stable_peer_id="stable-peer-a",
    )

    await handler.on_message(json.dumps({"type": "call", "id": "slow-1", "method": "Svc.Slow"}))
    duplicate_response = json.loads(send.call_args.args[0])
    assert duplicate_response["type"] == "error"
    assert duplicate_response["error"]["code"] == 409

    assert client._sync_peer_authority_acl("stable-peer-a", None) is True  # noqa: SLF001

    with contextlib.suppress(asyncio.CancelledError):
        await active
    assert cancelled.is_set()
    assert state["completed"] is False


# ── update_peer_permissions ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_update_peer_permissions_success(client, mock_deps):
    _, _, _, auth_service = mock_deps

    old_identity = _make_identity("user-1", ["TTS.*"])
    token = _make_token("user-1", ["*"])  # Wildcard token scopes
    client._peer_acl = {"peer-a": old_identity}
    client._peer_tokens = {"peer-a": token}

    updated_user = User(
        id="user-1",
        username="alice",
        password_hash="hashed",
        role="user",
        permissions=["TTS.*", "STT.*", "DB.Read"],
        is_admin=False,
    )
    auth_service.get_principal.return_value = updated_user

    result = await client.update_peer_permissions("peer-a")
    assert result is True

    new_identity = client._peer_acl["peer-a"]
    assert isinstance(new_identity, Identity)
    assert new_identity.principal_id == "user-1"
    # With wildcard token scopes, all user perms should be effective
    assert "TTS.*" in new_identity.effective_perms
    assert "STT.*" in new_identity.effective_perms
    assert "DB.Read" in new_identity.effective_perms


@pytest.mark.asyncio
async def test_update_peer_permissions_anonymous(client):
    """Cannot refresh permissions for an anonymous peer."""
    client._peer_acl = {"peer-a": ANONYMOUS}
    result = await client.update_peer_permissions("peer-a")
    assert result is False


@pytest.mark.asyncio
async def test_update_peer_permissions_unknown_peer(client):
    result = await client.update_peer_permissions("nonexistent")
    assert result is False


@pytest.mark.asyncio
async def test_update_peer_permissions_user_deleted(client, mock_deps):
    _, _, _, auth_service = mock_deps

    identity = _make_identity("user-deleted")
    client._peer_acl = {"peer-a": identity}
    auth_service.get_principal.return_value = None

    result = await client.update_peer_permissions("peer-a")
    assert result is False


@pytest.mark.asyncio
async def test_update_peer_permissions_uses_original_token_scopes(client, mock_deps):
    """Verify re-resolution uses stored token scopes, not old effective_perms."""
    _, _, _, auth_service = mock_deps

    # Old identity has narrow effective_perms
    old_identity = _make_identity("user-1", ["TTS.*"])
    # But original token has broader scopes
    token = _make_token("user-1", ["TTS.*", "STT.*"])
    client._peer_acl = {"peer-a": old_identity}
    client._peer_tokens = {"peer-a": token}

    updated_user = User(
        id="user-1",
        username="alice",
        password_hash="hashed",
        role="user",
        permissions=["TTS.*", "STT.*", "DB.Read"],
        is_admin=False,
    )
    auth_service.get_principal.return_value = updated_user

    result = await client.update_peer_permissions("peer-a")
    assert result is True

    new_identity = client._peer_acl["peer-a"]
    # Token scopes ["TTS.*", "STT.*"] ∩ user perms ["TTS.*", "STT.*", "DB.Read"]
    # = ["TTS.*", "STT.*"]
    assert "TTS.*" in new_identity.effective_perms
    assert "STT.*" in new_identity.effective_perms
    assert "DB.Read" not in new_identity.effective_perms  # Not in token scopes


@pytest.mark.asyncio
async def test_update_peer_permissions_no_stored_token_fallback(client, mock_deps):
    """Without stored token, falls back to identity.effective_perms as token_scopes."""
    _, _, _, auth_service = mock_deps

    old_identity = _make_identity("user-1", ["TTS.*"])
    client._peer_acl = {"peer-a": old_identity}
    # Intentionally no token stored

    updated_user = User(
        id="user-1",
        username="alice",
        password_hash="hashed",
        role="user",
        permissions=["TTS.*", "STT.*"],
        is_admin=False,
    )
    auth_service.get_principal.return_value = updated_user

    result = await client.update_peer_permissions("peer-a")
    assert result is True

    new_identity = client._peer_acl["peer-a"]
    # Falls back to old effective_perms as token_scopes = ["TTS.*"]
    assert "TTS.*" in new_identity.effective_perms


@pytest.mark.asyncio
async def test_update_peer_permissions_restores_bus_validated_mesh_scopes(client, mock_deps):
    """Proxy tokens without a row id use the freshly synchronized mesh principal."""

    _, _, _, auth_service = mock_deps
    old_identity = _make_identity("user-1", ["Orchestrator.use"])
    token = _make_token("user-1", ["Orchestrator.use"])
    token.id = "bus-validated"
    client._peer_acl = {"peer-a": old_identity}
    client._peer_tokens = {"peer-a": token}
    auth_service.get_principal.return_value = User(
        id="user-1",
        username="mesh-peer-a",
        password_hash="hashed",
        role="user",
        permissions=["Orchestrator.use", "Tooling.use"],
        is_admin=False,
    )

    result = await client.update_peer_permissions("peer-a")

    assert result is True
    assert client._peer_acl["peer-a"].effective_perms == frozenset(
        {"Orchestrator.use", "Tooling.use"}
    )
    assert token.scopes == ["Orchestrator.use", "Tooling.use"]
    auth_service.get_token_scopes.assert_not_awaited()


# ── close() cleanup ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_close_cancels_timeout_tasks(client):
    """close() cancels all pending auth timeout tasks and clears tokens."""
    pc1 = AsyncMock()
    pc2 = AsyncMock()
    task1 = MagicMock()
    task1.cancel = MagicMock()
    task2 = MagicMock()
    task2.cancel = MagicMock()

    client._pcs = {"peer-a": pc1, "peer-b": pc2}
    client._peer_acl = {"peer-a": _make_identity("u1"), "peer-b": _make_identity("u2")}
    client._peer_tokens = {"peer-a": _make_token("u1"), "peer-b": _make_token("u2")}
    client._peer_timeout_tasks = {"peer-a": task1, "peer-b": task2}

    # Mock adapter
    client._adapter = AsyncMock()

    await client.close()

    task1.cancel.assert_called_once()
    task2.cancel.assert_called_once()
    assert len(client._peer_timeout_tasks) == 0
    assert len(client._peer_tokens) == 0
    assert len(client._pcs) == 0
    assert len(client._peer_acl) == 0


@pytest.mark.asyncio
async def test_close_cancels_reconnect_proof_tasks(client):
    """close() cancels credential checks that are still waiting on Auth."""
    started = asyncio.Event()

    async def wait_forever() -> None:
        started.set()
        await asyncio.Event().wait()

    pc = AsyncMock()
    task = asyncio.create_task(wait_forever())
    await started.wait()
    client._reconnect_proof_tasks = {"peer-a": (pc, task)}

    await client.close()

    assert task.cancelled()
    assert client._reconnect_proof_tasks == {}


@pytest.mark.asyncio
async def test_close_drains_pending_provider_unavailable_tasks(client):
    started = asyncio.Event()
    release = asyncio.Event()

    async def send_when_released(_peer_id: str, _wire: str) -> bool:
        started.set()
        await release.wait()
        return True

    client._mesh_peer_id = "local-provider"
    client._stable_peer_sessions["stable-peer-a"] = "peer-a"
    client._peer_stable_ids["peer-a"] = "stable-peer-a"
    client._local_provider_ready["stable-peer-a"] = _provider_expectation("peer-a")
    client._is_peer_session_active = MagicMock(return_value=True)  # type: ignore[method-assign]  # noqa: SLF001
    client.send_to_peer_async = AsyncMock(side_effect=send_when_released)  # type: ignore[method-assign]

    client._invalidate_provider_export_all()  # noqa: SLF001
    await started.wait()
    task = client._local_provider_unavailable_tasks["stable-peer-a"].task  # noqa: SLF001
    release.set()

    await client.close()

    assert task.done()
    assert task.result() is None
    client.send_to_peer_async.assert_awaited_once()
    assert client._local_provider_unavailable_tasks == {}  # noqa: SLF001


@pytest.mark.asyncio
async def test_close_queues_new_ready_tombstone_after_blocked_old_tombstone(client):
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    sent: list[tuple[str, dict[str, object]]] = []

    async def send_with_blocked_first(peer_id: str, wire: str) -> bool:
        sent.append((peer_id, json.loads(wire)))
        if len(sent) == 1:
            first_started.set()
            await release_first.wait()
        return True

    client._mesh_peer_id = "local-provider"
    client._stable_peer_sessions["stable-peer-a"] = "old-session"
    client._peer_stable_ids["old-session"] = "stable-peer-a"
    client._local_provider_ready["stable-peer-a"] = _provider_expectation(
        "old-session",
        connection_epoch="old-epoch",
    )
    client._is_peer_session_active = MagicMock(return_value=True)  # type: ignore[method-assign]  # noqa: SLF001
    client.send_to_peer_async = AsyncMock(side_effect=send_with_blocked_first)  # type: ignore[method-assign]

    client._invalidate_provider_export_all()  # noqa: SLF001
    await asyncio.wait_for(first_started.wait(), timeout=1.0)

    client._stable_peer_sessions["stable-peer-a"] = "new-session"
    client._peer_stable_ids["new-session"] = "stable-peer-a"
    client._local_provider_ready["stable-peer-a"] = _provider_expectation(
        "new-session",
        connection_epoch="new-epoch",
    )

    close_task = asyncio.create_task(client.close())
    await asyncio.sleep(0.05)

    assert [peer_id for peer_id, _payload in sent] == ["old-session"]

    release_first.set()
    await asyncio.wait_for(close_task, timeout=1.0)

    assert [peer_id for peer_id, _payload in sent] == ["old-session", "new-session"]
    assert [payload["connection_epoch"] for _peer_id, payload in sent] == [
        "old-epoch",
        "new-epoch",
    ]
    assert [payload["reason_code"] for _peer_id, payload in sent] == [
        "provider_export_invalidated",
        "peer_closing",
    ]
    assert [payload["availability_revision"] for _peer_id, payload in sent] == [1, 2]
    assert client._local_provider_unavailable_tasks == {}  # noqa: SLF001


@pytest.mark.asyncio
async def test_close_bounds_blocked_provider_unavailable_drain(client):
    started = asyncio.Event()

    async def send_forever(_peer_id: str, _wire: str) -> bool:
        started.set()
        await asyncio.Event().wait()
        return True

    client._mesh_peer_id = "local-provider"
    client._stable_peer_sessions["stable-peer-a"] = "peer-a"
    client._peer_stable_ids["peer-a"] = "stable-peer-a"
    client._local_provider_ready["stable-peer-a"] = _provider_expectation("peer-a")
    client._is_peer_session_active = MagicMock(return_value=True)  # type: ignore[method-assign]  # noqa: SLF001
    client.send_to_peer_async = AsyncMock(side_effect=send_forever)  # type: ignore[method-assign]

    client._invalidate_provider_export_all()  # noqa: SLF001
    await asyncio.wait_for(started.wait(), timeout=1.0)
    task = client._local_provider_unavailable_tasks["stable-peer-a"].task  # noqa: SLF001

    await asyncio.wait_for(client.close(), timeout=1.0)

    assert task.done()
    assert task.cancelled()
    client.send_to_peer_async.assert_awaited_once()
    assert client._diagnostic_errors[0].code == "provider_unavailable_shutdown_timeout"  # noqa: SLF001
    assert client._local_provider_unavailable_tasks == {}  # noqa: SLF001
    assert client._peer_send_queues == {}  # noqa: SLF001
    assert client._peer_send_workers == {}  # noqa: SLF001


@pytest.mark.asyncio
async def test_set_rpc_bus_rewires_existing_rpc_handler_to_mesh_stream_path(client):
    """Mesh startup updates existing inbound handlers off the process bus."""
    import json

    from app.services.gateway.webrtc.rpc import RPCHandler
    from app.shared.contracts.models.gateway import MethodInfo, ServiceAnnouncement
    from app.shared.contracts.models.orchestrator import OrchestratorMethods

    process_bus = AsyncMock()
    process_bus.request = AsyncMock()
    if hasattr(process_bus, "stream_request"):
        delattr(process_bus, "stream_request")

    class _MeshBus:
        def __init__(self) -> None:
            self.stream_calls = []

        async def stream_request(self, topic, payload, **kwargs):
            self.stream_calls.append((topic, payload, kwargs))
            yield {"delta": "mesh"}

    class _Registry:
        async def get_service(self, service: str):
            assert service == "Orchestrator"
            return ServiceAnnouncement(
                module="Orchestrator",
                version="1.0",
                methods=[
                    MethodInfo(
                        name="StreamInferChat",
                        bus_topic=OrchestratorMethods.STREAM_INFER_CHAT,
                        exposure="external",
                        required_perms=["Orchestrator.use"],
                        method_type="use",
                    )
                ],
            )

        async def get_external_methods(self):
            return []

    identity = Identity(
        principal_id="peer-user",
        principal_name="peer-user",
        is_admin=False,
        effective_perms=frozenset({"Orchestrator.use"}),
        source="webrtc_peer",
    )
    send = MagicMock()
    handler = RPCHandler(process_bus, _Registry(), send, lambda: identity)
    client._rpc_handlers = {"remote-peer": handler}

    mesh_bus = _MeshBus()
    client.set_rpc_bus(mesh_bus)  # type: ignore[arg-type]

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "stream-1",
                "method": OrchestratorMethods.STREAM_INFER_CHAT,
                "params": {"messages": [{"role": "user", "content": "hi"}]},
            }
        )
    )

    assert client._bus is mesh_bus
    assert len(mesh_bus.stream_calls) == 1
    process_bus.request.assert_not_called()
    responses = [json.loads(call.args[0]) for call in send.call_args_list]
    assert [response["type"] for response in responses] == ["chunk", "eof"]


@pytest.mark.asyncio
async def test_disable_mesh_clears_runtime_fields_and_preserves_handler_fail_closed_policy(client):
    import json

    store = MeshPolicyStore()
    store.replace(MeshConfig(enabled=False), source_revision=1)
    bus = AsyncMock()
    send = MagicMock()
    identity = Identity(
        principal_id="peer-user",
        principal_name="peer-user",
        is_admin=False,
        effective_perms=frozenset({"TTS.use"}),
        source="webrtc_peer",
    )
    handler = RPCHandler(
        bus,
        AsyncMock(),
        send,
        lambda: identity,
        mesh_config=MeshConfig(enabled=True),
        peer_id="session-peer",
        stable_peer_id_provider=lambda: "stable-peer",
    )
    client._rpc_handlers = {"session-peer": handler}
    client._mesh_enabled = True
    client._mesh_config = MeshConfig(enabled=True)
    client._peer_registry = MagicMock()
    client._peer_bridge = MagicMock()
    client._mesh_peer_id = "local-peer"
    client._mesh_node_name = "local-node"
    client._stable_peer_sessions["stable-peer"] = "session-peer"
    client._peer_stable_ids["session-peer"] = "stable-peer"
    client._local_provider_ready["stable-peer"] = _provider_expectation(
        "session-peer",
        connection_epoch="disable-epoch",
    )
    client._is_peer_session_active = MagicMock(return_value=True)  # type: ignore[method-assign]  # noqa: SLF001
    client.send_to_peer_async = AsyncMock(return_value=True)  # type: ignore[method-assign]

    client.disable_mesh(policy_provider=store.provider())
    await _drain_provider_unavailable(client)

    assert client._mesh_enabled is False
    assert client._mesh_config is None
    assert client._peer_registry is None
    assert client._peer_bridge is None
    assert client._mesh_peer_id is None
    assert client._mesh_node_name == ""
    client.send_to_peer_async.assert_awaited_once()
    tombstone = json.loads(client.send_to_peer_async.await_args.args[1])
    assert tombstone["type"] == "provider_unavailable"
    assert tombstone["peer_id"] == "local-peer"
    assert tombstone["connection_epoch"] == "disable-epoch"
    assert tombstone["reason_code"] == "mesh_disabled"

    await handler.on_message(
        json.dumps(
            {
                "type": "event",
                "topic": "TTS.Started",
                "params": {"utterance_id": "u1"},
            }
        )
    )
    bus.publish.assert_not_called()
