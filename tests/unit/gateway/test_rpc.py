import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.messaging.bus import QueryResult
from app.services.gateway.acl.identity import Identity
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


@pytest.fixture
def mock_acl_provider():
    """Returns an Identity with limited permissions."""
    identity = Identity(
        principal_id="peer-user",
        principal_name="peer-user",
        is_admin=False,
        effective_perms=frozenset(["user"]),
        source="webrtc_peer",
    )
    return MagicMock(return_value=identity)


@pytest.fixture
def rpc_handler(mock_bus, mock_registry, mock_send_fn, mock_acl_provider):
    return RPCHandler(mock_bus, mock_registry, mock_send_fn, mock_acl_provider)


@pytest.mark.asyncio
async def test_on_message_invalid_json(rpc_handler):
    await rpc_handler.on_message("invalid json")
    rpc_handler._send.assert_not_called()


@pytest.mark.asyncio
async def test_on_message_ignore_non_call(rpc_handler):
    await rpc_handler.on_message(json.dumps({"type": "not_call"}))
    rpc_handler._send.assert_not_called()


@pytest.mark.asyncio
async def test_handle_call_missing_method(rpc_handler):
    await rpc_handler.on_message(json.dumps({"type": "call", "id": 1}))
    rpc_handler._send.assert_called_once()
    response = json.loads(rpc_handler._send.call_args[0][0])
    assert response["type"] == "error"
    assert response["error"]["code"] == 400


@pytest.mark.asyncio
async def test_handle_call_method_not_found(rpc_handler, mock_registry):
    mock_registry.get_service.return_value = None
    mock_registry.get_external_methods.return_value = []

    await rpc_handler.on_message(json.dumps({"type": "call", "id": 1, "method": "Svc.NonExistent"}))

    response = json.loads(rpc_handler._send.call_args[0][0])
    assert response["type"] == "error"
    assert response["error"]["code"] == 404


@pytest.mark.asyncio
async def test_handle_call_forbidden(rpc_handler, mock_registry, mock_acl_provider):
    method_info = MethodInfo(name="Secret", required_perms=["admin"])
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Svc", version="1.0", methods=[method_info]
    )
    # The default mock_acl_provider only has "user" permission, not "admin"

    await rpc_handler.on_message(json.dumps({"type": "call", "id": 1, "method": "Svc.Secret"}))

    response = json.loads(rpc_handler._send.call_args[0][0])
    assert response["type"] == "error"
    assert response["error"]["code"] == 403


@pytest.mark.asyncio
async def test_handle_call_success(rpc_handler, mock_registry, mock_bus):
    method_info = MethodInfo(name="Greet", bus_topic="Svc.Greet")
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Svc", version="1.0", methods=[method_info]
    )

    mock_bus.request.return_value = QueryResult(ok=True, data={"greeting": "hello"})

    await rpc_handler.on_message(
        json.dumps(
            {"type": "call", "id": "req-123", "method": "Svc.Greet", "params": {"name": "Alice"}}
        )
    )

    mock_bus.request.assert_called_once_with(
        "Svc.Greet", {"name": "Alice"}, timeout=30.0, origin="external", principal_id="peer-user"
    )

    response = json.loads(rpc_handler._send.call_args[0][0])
    assert response["type"] == "result"
    assert response["id"] == "req-123"
    assert response["result"] == {"greeting": "hello"}


@pytest.mark.asyncio
async def test_handle_call_bus_error(rpc_handler, mock_registry, mock_bus):
    method_info = MethodInfo(name="Fail")
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Svc", version="1.0", methods=[method_info]
    )

    mock_bus.request.return_value = QueryResult(ok=False, error="Something went wrong")

    await rpc_handler.on_message(json.dumps({"type": "call", "id": 1, "method": "Svc.Fail"}))

    response = json.loads(rpc_handler._send.call_args[0][0])
    assert response["type"] == "error"
    assert response["error"]["message"] == "Something went wrong"


@pytest.mark.asyncio
async def test_handle_call_timeout(rpc_handler, mock_registry, mock_bus):
    method_info = MethodInfo(name="Slow")
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Svc", version="1.0", methods=[method_info]
    )

    mock_bus.request.side_effect = TimeoutError()

    await rpc_handler.on_message(json.dumps({"type": "call", "id": 1, "method": "Svc.Slow"}))

    response = json.loads(rpc_handler._send.call_args[0][0])
    assert response["type"] == "error"
    assert response["error"]["code"] == 504


@pytest.mark.asyncio
async def test_handle_call_streaming(rpc_handler, mock_registry, mock_bus):
    method_info = MethodInfo(name="Stream")
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Svc", version="1.0", methods=[method_info]
    )

    async def mock_stream():
        yield "part1"
        yield b"part2"

    mock_bus.request.return_value = QueryResult(ok=True, data=mock_stream())

    await rpc_handler.on_message(json.dumps({"type": "call", "id": "s1", "method": "Svc.Stream"}))

    assert rpc_handler._send.call_count == 3

    calls = [json.loads(call[0][0]) for call in rpc_handler._send.call_args_list]
    assert calls[0] == {"type": "chunk", "id": "s1", "data": "part1"}
    assert calls[1] == {"type": "chunk", "id": "s1", "data": "part2"}
    assert calls[2] == {"type": "eof", "id": "s1"}


# ── Mesh sharing gate tests ─────────────────────────────────────────────


def _make_mesh_config(enabled: bool = True, sharing: dict | None = None):
    """Create a mock mesh config object."""
    cfg = MagicMock()
    cfg.enabled = enabled
    cfg.sharing = sharing or {}
    return cfg


def _make_sharing_entry(share: bool = True, allowed_peers=None, max_concurrent: int = 0):
    entry = MagicMock()
    entry.share = share
    entry.allowed_peers = allowed_peers
    entry.max_concurrent = max_concurrent
    return entry


@pytest.mark.asyncio
async def test_mesh_gate_blocks_unshared_service(
    mock_bus, mock_registry, mock_send_fn, mock_acl_provider,
):
    """When mesh is enabled but a service is not shared, calls are rejected 403."""
    mesh_config = _make_mesh_config(enabled=True, sharing={})
    handler = RPCHandler(
        mock_bus, mock_registry, mock_send_fn, mock_acl_provider,
        mesh_config=mesh_config,
    )
    # Doesn't need a real method — gate blocks before _find_method
    await handler.on_message(
        json.dumps({"type": "call", "id": "m1", "method": "TTS.Request"})
    )
    resp = json.loads(mock_send_fn.call_args[0][0])
    assert resp["type"] == "error"
    assert resp["error"]["code"] == 403
    assert "not shared" in resp["error"]["message"]


@pytest.mark.asyncio
async def test_mesh_gate_allows_shared_service(
    mock_bus, mock_registry, mock_send_fn, mock_acl_provider,
):
    """When a service IS shared, calls pass through the mesh gate."""
    mesh_config = _make_mesh_config(
        enabled=True,
        sharing={"TTS": _make_sharing_entry(share=True)},
    )
    handler = RPCHandler(
        mock_bus, mock_registry, mock_send_fn, mock_acl_provider,
        mesh_config=mesh_config,
    )

    method_info = MethodInfo(name="Request")
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="TTS", version="1.0", methods=[method_info],
    )
    mock_bus.request.return_value = QueryResult(ok=True, data={"status": "ok"})

    await handler.on_message(
        json.dumps({"type": "call", "id": "m2", "method": "TTS.Request"})
    )
    resp = json.loads(mock_send_fn.call_args[0][0])
    assert resp["type"] == "result"


@pytest.mark.asyncio
async def test_mesh_gate_skips_pairing_methods(
    mock_bus, mock_registry, mock_send_fn,
):
    """Pairing/auth infrastructure methods bypass the mesh sharing gate entirely."""
    # ANONYMOUS identity so we also verify ANON allowlist works together
    anon_identity = Identity(
        principal_id="anonymous",
        principal_name="anonymous",
        is_admin=False,
        effective_perms=frozenset(),
        source="webrtc_peer",
    )
    acl_provider = MagicMock(return_value=anon_identity)

    mesh_config = _make_mesh_config(enabled=True, sharing={})  # No services shared
    handler = RPCHandler(
        mock_bus, mock_registry, mock_send_fn, acl_provider,
        mesh_config=mesh_config,
    )

    method_info = MethodInfo(name="PairingStart")
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Auth", version="1.0", methods=[method_info],
    )
    mock_bus.request.return_value = QueryResult(ok=True, data={"code": "123456"})

    await handler.on_message(
        json.dumps({
            "type": "call", "id": "p1",
            "method": "Auth.PairingStart",
            "params": {"device_name": "test"},
        })
    )
    resp = json.loads(mock_send_fn.call_args[0][0])
    # Should NOT be blocked by mesh gate — pairing is infrastructure
    assert resp["type"] == "result"
    assert resp["result"]["code"] == "123456"


@pytest.mark.asyncio
async def test_mesh_gate_skips_login_method(
    mock_bus, mock_registry, mock_send_fn,
):
    """Auth.Login bypasses the mesh sharing gate."""
    anon_identity = Identity(
        principal_id="anonymous",
        principal_name="anonymous",
        is_admin=False,
        effective_perms=frozenset(),
        source="webrtc_peer",
    )
    acl_provider = MagicMock(return_value=anon_identity)

    mesh_config = _make_mesh_config(enabled=True, sharing={})
    handler = RPCHandler(
        mock_bus, mock_registry, mock_send_fn, acl_provider,
        mesh_config=mesh_config,
    )

    method_info = MethodInfo(name="Login")
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Auth", version="1.0", methods=[method_info],
    )
    mock_bus.request.return_value = QueryResult(ok=True, data={"token": "abc"})

    await handler.on_message(
        json.dumps({
            "type": "call", "id": "l1",
            "method": "Auth.Login",
            "params": {"username": "admin", "password": "pass"},
        })
    )
    resp = json.loads(mock_send_fn.call_args[0][0])
    assert resp["type"] == "result"


@pytest.mark.asyncio
async def test_mesh_gate_capacity_exceeded(
    mock_bus, mock_registry, mock_send_fn, mock_acl_provider,
):
    """When a shared service is at capacity, calls are rejected 429."""
    sharing = _make_sharing_entry(share=True, max_concurrent=1)
    mesh_config = _make_mesh_config(
        enabled=True, sharing={"TTS": sharing},
    )
    handler = RPCHandler(
        mock_bus, mock_registry, mock_send_fn, mock_acl_provider,
        mesh_config=mesh_config,
    )
    # Simulate an active call already
    handler._active_remote_calls["TTS"] = 1

    await handler.on_message(
        json.dumps({"type": "call", "id": "c1", "method": "TTS.Request"})
    )
    resp = json.loads(mock_send_fn.call_args[0][0])
    assert resp["type"] == "error"
    assert resp["error"]["code"] == 429


@pytest.mark.asyncio
async def test_handle_call_datetime_in_response(rpc_handler, mock_registry, mock_bus):
    """RPC result containing a datetime must be serialized via ISO-8601."""
    from datetime import datetime, timedelta

    method_info = MethodInfo(name="PairingConnect", bus_topic="Auth.PairingConnect")
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="Auth", version="1.0", methods=[method_info]
    )

    expires = datetime(2025, 7, 1, 12, 0, 0)
    mock_bus.request.return_value = QueryResult(
        ok=True,
        data={
            "request_id": "abc",
            "device_name": "dev",
            "status": "pending",
            "expires_at": expires,
        },
    )

    await rpc_handler.on_message(
        json.dumps(
            {"type": "call", "id": "dt-1", "method": "Auth.PairingConnect", "params": {"code": "123456"}}
        )
    )

    response = json.loads(rpc_handler._send.call_args[0][0])
    assert response["type"] == "result"
    assert response["id"] == "dt-1"
    assert response["result"]["expires_at"] == "2025-07-01T12:00:00"
