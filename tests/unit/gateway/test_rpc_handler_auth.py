"""Tests for RPC handler ANONYMOUS gates (Gap 2).

Tests that ANONYMOUS peers are blocked from RPC calls and events,
except for pairing/auth methods.
"""

import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.messaging.bus import QueryResult
from app.services.gateway.acl.identity import ANONYMOUS, Identity
from app.services.gateway.webrtc.rpc import RPCHandler
from app.shared.contracts.models.gateway import MethodInfo, ServiceAnnouncement


@pytest.fixture
def mock_bus():
    return AsyncMock()


@pytest.fixture
def mock_registry():
    return AsyncMock()


@pytest.fixture
def mock_send_fn():
    return MagicMock()


def _make_anonymous_acl():
    """Return an ACL provider that returns ANONYMOUS."""
    return MagicMock(return_value=ANONYMOUS)


def _make_authenticated_acl():
    """Return an ACL provider with normal permissions."""
    identity = Identity(
        principal_id="peer-user",
        principal_name="peer-user",
        is_admin=False,
        effective_perms=frozenset(["user", "read"]),
        source="webrtc_peer",
    )
    return MagicMock(return_value=identity)


@pytest.mark.asyncio
async def test_anonymous_blocked_from_rpc_call(mock_bus, mock_registry, mock_send_fn):
    """ANONYMOUS peer calling non-pairing method gets 401."""
    handler = RPCHandler(
        mock_bus, mock_registry, mock_send_fn,
        _make_anonymous_acl(),
    )

    # Set up registry to return a method
    method_info = MagicMock(spec=MethodInfo)
    method_info.name = "DoSomething"
    method_info.required_perms = []
    method_info.bus_topic = "SomeService.DoSomething"

    announcement = MagicMock(spec=ServiceAnnouncement)
    announcement.methods = [method_info]
    mock_registry.get_service.return_value = announcement

    await handler.on_message(json.dumps({
        "type": "call", "id": "1",
        "method": "SomeService.DoSomething",
        "params": {},
    }))

    # Should get 401 error
    mock_send_fn.assert_called_once()
    response = json.loads(mock_send_fn.call_args[0][0])
    assert response["type"] == "error"
    assert response["error"]["code"] == 401


@pytest.mark.asyncio
async def test_anonymous_allowed_pairing_start(mock_bus, mock_registry, mock_send_fn):
    """ANONYMOUS peer calling PairingStart is allowed through."""
    handler = RPCHandler(
        mock_bus, mock_registry, mock_send_fn,
        _make_anonymous_acl(),
    )

    method_info = MagicMock(spec=MethodInfo)
    method_info.name = "PairingStart"
    method_info.required_perms = []
    method_info.bus_topic = "Auth.PairingStart"

    announcement = MagicMock(spec=ServiceAnnouncement)
    announcement.methods = [method_info]
    mock_registry.get_service.return_value = announcement

    mock_bus.request.return_value = QueryResult(ok=True, data={"code": "123456", "expires_in_seconds": 300})

    await handler.on_message(json.dumps({
        "type": "call", "id": "2",
        "method": "Auth.PairingStart",
        "params": {"device_name": "test-device"},
    }))

    # Should get a result, not an error
    mock_send_fn.assert_called_once()
    response = json.loads(mock_send_fn.call_args[0][0])
    assert response["type"] == "result"


@pytest.mark.asyncio
async def test_anonymous_allowed_pairing_exchange(mock_bus, mock_registry, mock_send_fn):
    """ANONYMOUS peer calling PairingExchange is allowed through."""
    handler = RPCHandler(
        mock_bus, mock_registry, mock_send_fn,
        _make_anonymous_acl(),
    )

    method_info = MagicMock(spec=MethodInfo)
    method_info.name = "PairingExchange"
    method_info.required_perms = []
    method_info.bus_topic = "Auth.PairingExchange"

    announcement = MagicMock(spec=ServiceAnnouncement)
    announcement.methods = [method_info]
    mock_registry.get_service.return_value = announcement

    mock_bus.request.return_value = QueryResult(ok=True, data={"token": "abc", "device_id": "d1", "user_id": "u1"})

    await handler.on_message(json.dumps({
        "type": "call", "id": "3",
        "method": "Auth.PairingExchange",
        "params": {"code": "123456"},
    }))

    mock_send_fn.assert_called_once()
    response = json.loads(mock_send_fn.call_args[0][0])
    assert response["type"] == "result"


@pytest.mark.asyncio
async def test_anonymous_blocked_from_event(mock_bus, mock_registry, mock_send_fn):
    """ANONYMOUS peer sending an event gets it blocked (not published to bus)."""
    handler = RPCHandler(
        mock_bus, mock_registry, mock_send_fn,
        _make_anonymous_acl(),
    )

    await handler.on_message(json.dumps({
        "type": "event",
        "topic": "TTS.Started",
        "params": {"text": "hello"},
    }))

    # Bus.publish should NOT have been called
    mock_bus.publish.assert_not_called()


@pytest.mark.asyncio
async def test_authenticated_peer_rpc_works(mock_bus, mock_registry, mock_send_fn):
    """Authenticated peer can call any method they have permissions for."""
    handler = RPCHandler(
        mock_bus, mock_registry, mock_send_fn,
        _make_authenticated_acl(),
    )

    method_info = MagicMock(spec=MethodInfo)
    method_info.name = "DoSomething"
    method_info.required_perms = ["user"]
    method_info.bus_topic = "SomeService.DoSomething"

    announcement = MagicMock(spec=ServiceAnnouncement)
    announcement.methods = [method_info]
    mock_registry.get_service.return_value = announcement

    mock_bus.request.return_value = QueryResult(ok=True, data={"result": "ok"})

    await handler.on_message(json.dumps({
        "type": "call", "id": "4",
        "method": "SomeService.DoSomething",
        "params": {},
    }))

    mock_send_fn.assert_called_once()
    response = json.loads(mock_send_fn.call_args[0][0])
    assert response["type"] == "result"
