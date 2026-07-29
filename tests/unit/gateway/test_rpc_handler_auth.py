"""Tests for RPC handler ANONYMOUS gates (Gap 2).

Tests that ANONYMOUS peers are blocked from RPC calls and events,
except for pairing/auth methods.
"""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.messaging.bus import QueryResult
from app.services.gateway.acl.identity import ANONYMOUS, Identity
from app.services.gateway.webrtc.event_subscriptions import MeshEventSubscriptionRegistry
from app.services.gateway.webrtc.peer_protocol import CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1
from app.services.gateway.webrtc.rpc import RPCHandler
from app.shared.contracts.models.gateway import MethodInfo, ServiceAnnouncement
from app.shared.contracts.models.tts import TTSMethods
from tests.unit.gateway.mesh_policy_helpers import mesh_policy


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
    return _make_acl_with_perms("user", "read")


def _make_acl_with_perms(*perms: str):
    """Return an ACL provider with explicit permissions."""
    identity = Identity(
        principal_id="peer-user",
        principal_name="peer-user",
        is_admin=False,
        effective_perms=frozenset(perms),
        source="webrtc_peer",
    )
    return MagicMock(return_value=identity)


def _make_mesh_config(enabled: bool = True, sharing: dict | None = None):
    cfg = MagicMock()
    cfg.enabled = enabled
    cfg.services = sharing or {}
    return cfg


def _active_projection(*, services: list | None = None):
    return SimpleNamespace(
        cache_key=SimpleNamespace(recipient_peer_id="peer-a", provider_peer_id="provider-a"),
        readiness="ready",
        routable=True,
        services=services or [],
    )


def _projected_service(module: str, *topics: str):
    return SimpleNamespace(
        service_id=module,
        capacity={"max_concurrent": 0},
        methods=[
            SimpleNamespace(
                topic=topic,
                required_permissions=(topic,),
                method_type="use",
            )
            for topic in topics
        ],
    )


@pytest.mark.asyncio
async def test_anonymous_blocked_from_rpc_call(mock_bus, mock_registry, mock_send_fn):
    """ANONYMOUS peer calling non-pairing method gets 401."""
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_anonymous_acl(),
    )

    # Set up registry to return a method
    method_info = MagicMock(spec=MethodInfo)
    method_info.name = "DoSomething"
    method_info.required_perms = []
    method_info.bus_topic = "SomeService.DoSomething"
    method_info.method_type = "use"
    method_info.exposure = "external"
    method_info.input_model = None

    announcement = MagicMock(spec=ServiceAnnouncement)
    announcement.methods = [method_info]
    mock_registry.get_service.return_value = announcement

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "1",
                "method": "SomeService.DoSomething",
                "params": {},
            }
        )
    )

    # Should get 401 error
    mock_send_fn.assert_called_once()
    response = json.loads(mock_send_fn.call_args[0][0])
    assert response["type"] == "error"
    assert response["error"]["code"] == 401


@pytest.mark.asyncio
async def test_anonymous_allowed_pairing_start(mock_bus, mock_registry, mock_send_fn):
    """ANONYMOUS peer calling PairingStart is allowed through."""
    pairing_context = {
        "pairing_session_id": "a" * 64,
        "verification_code": "48271935",
        "device_name": "test-device",
        "remote_peer_id": "stable-test-peer",
        "remote_node_name": "test-device",
        "room_name": "private-room",
    }
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_anonymous_acl(),
        pairing_context_provider=lambda: pairing_context,
    )

    method_info = MagicMock(spec=MethodInfo)
    method_info.name = "PairingStart"
    method_info.required_perms = []
    method_info.bus_topic = "Auth.PairingStart"
    method_info.method_type = "use"
    method_info.exposure = "external"
    method_info.input_model = None

    announcement = MagicMock(spec=ServiceAnnouncement)
    announcement.methods = [method_info]
    mock_registry.get_service.return_value = announcement

    mock_bus.request.return_value = QueryResult(
        ok=True, data={"code": "123456", "expires_in_seconds": 300}
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "2",
                "method": "Auth.PairingStart",
                "params": {
                    "device_name": "test-device",
                    "remote_peer_id": "stable-test-peer",
                    "remote_node_name": "test-device",
                    "pairing_session_id": "a" * 64,
                    "verification_code": "48271935",
                    "room_name": "private-room",
                },
            }
        )
    )

    # Should get a result, not an error
    mock_send_fn.assert_called_once()
    response = json.loads(mock_send_fn.call_args[0][0])
    assert response["type"] == "result"


@pytest.mark.asyncio
async def test_durable_pairing_denial_notifies_transport_after_result_is_sent(
    mock_bus,
    mock_registry,
):
    """The local RTC must suppress retry even if the peer's terminal is dropped."""
    events: list[str] = []
    send_fn = MagicMock(side_effect=lambda _message: events.append("result_sent"))
    denied_fn = MagicMock(side_effect=lambda _peer: events.append("denial_notified"))
    pairing_context = {
        "pairing_session_id": "a" * 64,
        "verification_code": "48271935",
        "device_name": "test-device",
        "remote_peer_id": "stable-test-peer",
        "remote_node_name": "test-device",
        "room_name": "private-room",
    }
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        send_fn,
        _make_anonymous_acl(),
        peer_id="signaling-peer",
        pairing_context_provider=lambda: pairing_context,
        pairing_denied_fn=denied_fn,
    )
    method_info = MagicMock(spec=MethodInfo)
    method_info.name = "PairingStart"
    method_info.required_perms = []
    method_info.bus_topic = "Auth.PairingStart"
    method_info.method_type = "use"
    method_info.exposure = "external"
    method_info.input_model = None
    announcement = MagicMock(spec=ServiceAnnouncement)
    announcement.methods = [method_info]
    mock_registry.get_service.return_value = announcement
    mock_bus.request.return_value = QueryResult(
        ok=True,
        data={"error": "Pairing denied", "status": "denied"},
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "denied-1",
                "method": "Auth.PairingStart",
                "params": pairing_context,
            }
        )
    )

    assert events == ["result_sent", "denial_notified"]
    denied_fn.assert_called_once_with("signaling-peer")


@pytest.mark.asyncio
async def test_anonymous_allowed_pairing_exchange(mock_bus, mock_registry, mock_send_fn):
    """ANONYMOUS peer calling PairingExchange is allowed through."""
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_anonymous_acl(),
    )

    method_info = MagicMock(spec=MethodInfo)
    method_info.name = "PairingExchange"
    method_info.required_perms = []
    method_info.bus_topic = "Auth.PairingExchange"
    method_info.method_type = "use"
    method_info.exposure = "external"
    method_info.input_model = None

    announcement = MagicMock(spec=ServiceAnnouncement)
    announcement.methods = [method_info]
    mock_registry.get_service.return_value = announcement

    mock_bus.request.return_value = QueryResult(
        ok=True, data={"token": "abc", "device_id": "d1", "user_id": "u1"}
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "3",
                "method": "Auth.PairingExchange",
                "params": {"code": "123456"},
            }
        )
    )

    mock_send_fn.assert_called_once()
    response = json.loads(mock_send_fn.call_args[0][0])
    assert response["type"] == "result"


@pytest.mark.asyncio
async def test_anonymous_blocked_from_event(mock_bus, mock_registry, mock_send_fn):
    """ANONYMOUS peer sending an event gets it blocked (not published to bus)."""
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_anonymous_acl(),
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "event",
                "topic": "TTS.Started",
                "params": {"text": "hello"},
            }
        )
    )

    # Bus.publish should NOT have been called
    mock_bus.publish.assert_not_called()


@pytest.mark.asyncio
async def test_authenticated_peer_rpc_works(mock_bus, mock_registry, mock_send_fn):
    """Authenticated peer can call any method they have permissions for."""
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_authenticated_acl(),
    )

    method_info = MagicMock(spec=MethodInfo)
    method_info.name = "DoSomething"
    method_info.required_perms = ["user"]
    method_info.method_type = "use"
    method_info.exposure = "external"
    method_info.bus_topic = "SomeService.DoSomething"
    method_info.input_model = None

    announcement = MagicMock(spec=ServiceAnnouncement)
    announcement.methods = [method_info]
    mock_registry.get_service.return_value = announcement

    mock_bus.request.return_value = QueryResult(ok=True, data={"result": "ok"})

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "4",
                "method": "SomeService.DoSomething",
                "params": {},
            }
        )
    )

    mock_send_fn.assert_called_once()
    response = json.loads(mock_send_fn.call_args[0][0])
    assert response["type"] == "result"


@pytest.mark.asyncio
async def test_mesh_gate_blocks_provider_rpc_until_manifest_ack_readiness(
    mock_bus,
    mock_registry,
    mock_send_fn,
):
    mesh_config = _make_mesh_config(
        enabled=True,
        sharing={"TTS": mesh_policy(share=True)},
    )
    method_info = MethodInfo(
        name="Request",
        bus_topic="TTS.Request",
        exposure="external",
        required_perms=["TTS.Request"],
    )
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="TTS",
        version="1.0",
        methods=[method_info],
    )
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms("TTS.Request"),
        mesh_config=mesh_config,
        stable_peer_id_provider=lambda: "peer-a",
        active_projection_provider=lambda: _active_projection(
            services=[_projected_service("TTS", "TTS.Request")]
        ),
        provider_readiness_provider=lambda _service_id: False,
    )

    await handler.on_message(
        json.dumps({"type": "call", "id": "not-ready", "method": "TTS.Request"})
    )

    response = json.loads(mock_send_fn.call_args.args[0])
    assert response["type"] == "error"
    assert response["error"]["code"] == 425
    assert response["error"]["message"] == "Provider is not ready"
    mock_bus.request.assert_not_called()

    mock_send_fn.reset_mock()
    ready_handler = RPCHandler(
        mock_bus,
        mock_registry,
        mock_send_fn,
        _make_acl_with_perms("TTS.Request"),
        mesh_config=mesh_config,
        stable_peer_id_provider=lambda: "peer-a",
        active_projection_provider=lambda: _active_projection(
            services=[_projected_service("TTS", "TTS.Request")]
        ),
        provider_readiness_provider=lambda _service_id: True,
    )
    mock_bus.request.return_value = QueryResult(ok=True, data={"status": "ok"})
    await ready_handler.on_message(
        json.dumps({"type": "call", "id": "ready", "method": "TTS.Request"})
    )

    mock_bus.request.assert_awaited_once()
    assert json.loads(mock_send_fn.call_args.args[0])["type"] == "result"


@pytest.mark.asyncio
async def test_scoped_subscribe_blocks_unacknowledged_provider_service_events(
    mock_bus,
    mock_registry,
):
    readiness: dict[str, bool] = {"TTS": False}
    sent: list[dict] = []
    subscriptions = MeshEventSubscriptionRegistry()
    method_info = MethodInfo(
        name="Started",
        bus_topic=TTSMethods.STARTED,
        exposure="external",
        required_perms=["TTS.Started"],
    )
    mock_registry.get_service.return_value = ServiceAnnouncement(
        module="TTS",
        version="1.0",
        methods=[method_info],
    )
    handler = RPCHandler(
        mock_bus,
        mock_registry,
        lambda text: sent.append(json.loads(text)),
        _make_acl_with_perms("TTS.Started"),
        mesh_config=_make_mesh_config(enabled=True, sharing={"TTS": mesh_policy(share=True)}),
        stable_peer_id_provider=lambda: "peer-a",
        authenticated_peer_validator=lambda: True,
        event_subscription_registry=subscriptions,
        peer_supports_capability=lambda cap: cap == CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1,
        provider_readiness_provider=lambda service_id: readiness.get(service_id, False),
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "subscribe",
                "id": "sub-not-ready",
                "params": {"subscription_id": "sub-1", "topics": [TTSMethods.STARTED]},
            }
        )
    )

    assert sent[-1]["type"] == "subscribe_rejected"
    assert sent[-1]["accepted"] is False
    assert sent[-1]["rejected_topics"] == [
        {"topic": TTSMethods.STARTED, "reason": "unauthorized_topic"}
    ]
    assert subscriptions.is_interested("peer-a", TTSMethods.STARTED) is False

    readiness["TTS"] = True
    await handler.on_message(
        json.dumps(
            {
                "type": "subscribe",
                "id": "sub-ready",
                "params": {"subscription_id": "sub-2", "topics": [TTSMethods.STARTED]},
            }
        )
    )

    assert sent[-1]["type"] == "subscribed"
    assert sent[-1]["accepted_topics"] == [TTSMethods.STARTED]
    assert subscriptions.is_interested("peer-a", TTSMethods.STARTED) is True
