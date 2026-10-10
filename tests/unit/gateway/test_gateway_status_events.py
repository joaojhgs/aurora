from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.gateway.config import MeshConfig
from app.services.gateway.mesh.peer_bridge import PeerBridge
from app.services.gateway.service import GatewayService
from app.services.gateway.webrtc.event_subscriptions import MeshEventSubscriptionRegistry
from app.services.gateway.webrtc.peer_protocol import (
    CAP_GATEWAY_STATUS_EVENTS_V1,
    CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1,
)
from app.services.gateway.webrtc.rpc import RPCHandler
from app.services.gateway.webrtc.rtc_client import RTCClient
from app.shared.auth.identity import Identity
from app.shared.contracts.models.config import ConfigMethods
from app.shared.contracts.models.gateway import GatewayMethods


def _identity(*permissions: str, source: str = "webrtc_peer") -> Identity:
    return Identity(
        principal_id="peer-principal",
        principal_name="peer-principal",
        effective_perms=frozenset(permissions),
        source=source,
    )


def _mesh(*, enabled: bool = True) -> MeshConfig:
    return MeshConfig(enabled=enabled, services={})


@pytest.mark.unit
def test_status_projection_whitelists_config_and_normalizes_service_id() -> None:
    event = GatewayService._status_changed_event(
        ConfigMethods.UPDATED,
        {"key_path": "api.token_secret", "new_value": "secret", "innocuous": "drop"},
    )
    assert event is not None
    assert event.kind == "config.updated"
    assert event.status == "updated"
    assert event.model_dump(exclude_none=True).keys() == {
        "event_id",
        "timestamp",
        "kind",
        "status",
        "freshness",
    }
    announced = GatewayService._status_changed_event(
        GatewayMethods.SERVICE_ANNOUNCE, {"module": "Tooling", "summary": "drop"}
    )
    assert announced is not None
    assert announced.kind == "service.announced"
    assert announced.service_id == "Tooling"
    assert (
        GatewayService._status_changed_event(
            GatewayMethods.SERVICE_DEPART, {"module": "bad id/secret"}
        ).service_id
        is None
    )


@pytest.mark.unit
@pytest.mark.asyncio
async def test_status_subscription_authorization_matrix() -> None:
    def make(**overrides: object) -> RPCHandler:
        values = {
            "stable_peer_id_provider": lambda: "stable-peer",
            "authenticated_peer_validator": lambda: True,
            "peer_supports_capability": lambda cap: cap
            in {CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1, CAP_GATEWAY_STATUS_EVENTS_V1},
            "mesh_config": _mesh(),
            "acl_provider": lambda: _identity("Gateway.use"),
            "status_event_authorizer": lambda _peer: True,
        }
        values.update(overrides)
        return RPCHandler(
            AsyncMock(), AsyncMock(), lambda _text: None, values.pop("acl_provider"), **values
        )

    accepted = await make()._authorized_event_topics(
        (GatewayMethods.STATUS_CHANGED,), _identity("Gateway.use")
    )
    assert accepted == {GatewayMethods.STATUS_CHANGED}
    assert (
        await make()._authorized_event_topics((GatewayMethods.STATUS_CHANGED,), _identity())
        == set()
    )
    assert (
        await make()._authorized_event_topics(
            (GatewayMethods.STATUS_CHANGED,), _identity("Gateway.use", source="http_bearer")
        )
        == set()
    )
    assert (
        await make(peer_supports_capability=lambda _cap: False)._authorized_event_topics(
            (GatewayMethods.STATUS_CHANGED,), _identity("Gateway.use")
        )
        == set()
    )
    assert (
        await make(authenticated_peer_validator=lambda: False)._authorized_event_topics(
            (GatewayMethods.STATUS_CHANGED,), _identity("Gateway.use")
        )
        == set()
    )
    assert (
        await make(mesh_config=_mesh(enabled=False))._authorized_event_topics(
            (GatewayMethods.STATUS_CHANGED,), _identity("Gateway.use")
        )
        == set()
    )
    assert (
        await make(status_event_authorizer=None)._authorized_event_topics(
            (GatewayMethods.STATUS_CHANGED,), _identity("Gateway.use")
        )
        == set()
    )
    assert (
        await make(status_event_authorizer=lambda _peer: False)._authorized_event_topics(
            (GatewayMethods.STATUS_CHANGED,), _identity("Gateway.use")
        )
        == set()
    )
    raw = (
        ConfigMethods.UPDATED,
        "Gateway.ServiceAnnounce",
        "Gateway.Health",
        "Service.Announcement",
    )
    assert await make()._authorized_event_topics(raw, _identity("Gateway.use")) == set()


@pytest.mark.unit
@pytest.mark.asyncio
async def test_status_topic_is_not_an_rpc_method_or_inbound_forwarded_event() -> None:
    bus = AsyncMock()
    sent: list[dict] = []
    subscriptions = MeshEventSubscriptionRegistry()
    handler = RPCHandler(
        bus,
        AsyncMock(),
        lambda text: sent.append(json.loads(text)),
        lambda: _identity("Gateway.use"),
        stable_peer_id_provider=lambda: "stable-peer",
        authenticated_peer_validator=lambda: True,
        peer_supports_capability=lambda _cap: True,
        mesh_config=_mesh(),
        status_event_authorizer=lambda _peer: True,
        event_subscription_registry=subscriptions,
    )
    await handler.on_message(
        json.dumps(
            {"type": "call", "id": "1", "method": GatewayMethods.STATUS_CHANGED, "params": {}}
        )
    )
    assert not bus.request.await_args_list
    await handler.on_message(
        json.dumps(
            {
                "type": "subscribe",
                "id": "sub-raw",
                "topics": [GatewayMethods.GET_SERVICE_HEALTH, ConfigMethods.UPDATED],
            }
        )
    )
    assert sent[-1]["type"] == "subscribe_rejected"
    assert subscriptions.snapshot().subscription_count == 0
    await handler.on_message(
        json.dumps(
            {
                "type": "subscribe",
                "id": "sub-status",
                "topics": [GatewayMethods.STATUS_CHANGED],
            }
        )
    )
    assert sent[-1]["type"] == "subscribed"
    assert subscriptions.snapshot().subscription_count == 1
    assert subscriptions.is_interested(
        "stable-peer", GatewayMethods.STATUS_CHANGED, None, sensitive=False
    )
    await handler._handle_event(
        {"topic": GatewayMethods.STATUS_CHANGED, "params": {"kind": "config.updated"}}
    )
    assert not bus.publish.await_args_list


@pytest.mark.unit
@pytest.mark.asyncio
async def test_peer_bridge_status_delivery_requires_capability_and_subscription() -> None:
    registry = MeshEventSubscriptionRegistry()
    sent: list[str] = []
    current = {"authorized": True, "ready": True}
    client = SimpleNamespace(
        event_subscriptions=registry,
        peer_supports_capability=lambda _peer, cap: cap
        in {CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1, CAP_GATEWAY_STATUS_EVENTS_V1},
        send_to_peer=lambda _peer, text: sent.append(text) or True,
    )
    bridge = PeerBridge(
        client,
        MagicMock(),
        status_event_authorizer=lambda _peer: current["authorized"] and current["ready"],
    )
    assert (
        await bridge.fire_event_async(
            "peer", GatewayMethods.STATUS_CHANGED, {"kind": "config.updated"}
        )
        is False
    )
    no_authority_bridge = PeerBridge(client, MagicMock())
    assert (
        await no_authority_bridge.fire_event_async(
            "peer", GatewayMethods.STATUS_CHANGED, {"kind": "config.updated"}
        )
        is False
    )
    registry.subscribe(
        peer_id="peer",
        subscription_id="status",
        requested_topics=[GatewayMethods.STATUS_CHANGED],
        allowed_topics=[GatewayMethods.STATUS_CHANGED],
    )
    assert (
        await bridge.fire_event_async(
            "peer", GatewayMethods.STATUS_CHANGED, {"kind": "config.updated"}
        )
        is True
    )
    assert sent
    status_frame = json.loads(sent[-1])
    assert "correlation_id" not in status_frame
    assert (
        await bridge.fire_event_async(
            "peer", GatewayMethods.STATUS_CHANGED, {"kind": "config.updated"}, "status-correlation"
        )
        is True
    )
    assert json.loads(sent[-1])["correlation_id"] == "status-correlation"
    current["authorized"] = False
    assert (
        await bridge.fire_event_async(
            "peer", GatewayMethods.STATUS_CHANGED, {"kind": "config.updated"}
        )
        is False
    )
    current["authorized"] = True
    current["ready"] = False
    assert (
        await bridge.fire_event_async(
            "peer", GatewayMethods.STATUS_CHANGED, {"kind": "config.updated"}
        )
        is False
    )
    raising_bridge = PeerBridge(
        client,
        MagicMock(),
        status_event_authorizer=lambda _peer: (_ for _ in ()).throw(RuntimeError("revoked")),
    )
    assert (
        await raising_bridge.fire_event_async(
            "peer", GatewayMethods.STATUS_CHANGED, {"kind": "config.updated"}
        )
        is False
    )
    registry.unsubscribe(peer_id="peer", subscription_id="status")
    assert (
        await bridge.fire_event_async(
            "peer", GatewayMethods.STATUS_CHANGED, {"kind": "config.updated"}
        )
        is False
    )


@pytest.mark.unit
def test_rtc_status_authority_tracks_current_session_and_permissions() -> None:
    rtc = object.__new__(RTCClient)
    identity = _identity("Gateway.use")
    rtc._stable_peer_sessions = {"stable": "session"}
    rtc._peer_stable_ids = {"session": "stable"}
    rtc._peer_acl = {"stable": identity, "session": identity}
    rtc._pcs = {"session": SimpleNamespace(connectionState="connected")}
    rtc._peer_data_channels = {"session": SimpleNamespace(readyState="open")}
    rtc._peer_protocols = {
        "session": SimpleNamespace(
            supports=lambda cap: cap
            in {
                CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1,
                CAP_GATEWAY_STATUS_EVENTS_V1,
            }
        )
    }
    rtc._event_subscriptions = MeshEventSubscriptionRegistry()
    rtc._mesh_enabled = True
    rtc._mesh_config = MeshConfig(enabled=True, services={})
    rtc._mesh_policy_provider = None
    rtc._event_subscriptions.subscribe(
        peer_id="stable",
        subscription_id="status",
        requested_topics=[GatewayMethods.STATUS_CHANGED],
        allowed_topics=[GatewayMethods.STATUS_CHANGED],
    )
    assert rtc.peer_can_receive_gateway_status("stable") is True
    assert rtc.gateway_status_event_recipient_ids() == ["stable"]
    rtc._stable_peer_sessions["stable"] = "replacement"
    rtc._peer_stable_ids["replacement"] = "stable"
    rtc._peer_acl["replacement"] = identity
    rtc._pcs["replacement"] = SimpleNamespace(connectionState="connected")
    rtc._peer_data_channels["replacement"] = SimpleNamespace(readyState="open")
    rtc._peer_protocols["replacement"] = rtc._peer_protocols["session"]
    assert rtc.peer_can_receive_gateway_status("session") is False
    assert rtc.gateway_status_event_recipient_ids() == ["stable"]
    rtc._peer_acl["stable"] = _identity()
    assert rtc.peer_can_receive_gateway_status("stable") is False
    assert rtc.gateway_status_event_recipient_ids() == []
    rtc._peer_acl["stable"] = identity
    rtc._mesh_enabled = False
    assert rtc.gateway_status_event_recipient_ids() == []
