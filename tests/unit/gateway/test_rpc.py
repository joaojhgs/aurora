import json
import pytest
from unittest.mock import MagicMock, AsyncMock
from app.services.gateway.webrtc.rpc import RPCHandler
from app.shared.contracts.models.gateway import MethodInfo, ServiceAnnouncement
from app.messaging.bus import QueryResult


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
    return MagicMock(return_value={"perms": ["user"], "roles": []})


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
    mock_acl_provider.return_value = {"perms": ["user"]}

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
        "Svc.Greet", {"name": "Alice"}, timeout=30.0, origin="external"
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
