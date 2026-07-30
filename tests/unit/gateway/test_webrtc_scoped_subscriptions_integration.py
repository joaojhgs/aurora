from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from pydantic import BaseModel

from app.messaging.bus import QueryResult
from app.messaging.mesh_bus import MeshBus
from app.services.gateway.acl.identity import Identity
from app.services.gateway.config import MeshConfig
from app.services.gateway.mesh.models import RouteDecision
from app.services.gateway.mesh.peer_bridge import PeerBridge
from app.services.gateway.webrtc.event_subscriptions import MeshEventSubscriptionRegistry
from app.services.gateway.webrtc.peer_protocol import CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1
from app.services.gateway.webrtc.rpc import RPCHandler
from app.shared.contracts.models.gateway import MethodInfo, ServiceAnnouncement
from app.shared.contracts.models.orchestrator import OrchestratorMethods
from app.shared.contracts.models.tts import TTSMethods
from tests.unit.gateway.mesh_policy_helpers import mesh_policy


class Payload(BaseModel):
    text: str = "hello"


def _identity(*perms: str, principal_id: str = "peer-user", source: str = "webrtc_peer"):
    return Identity(
        principal_id=principal_id,
        principal_name=principal_id,
        is_admin=False,
        effective_perms=frozenset(perms),
        source=source,
    )


@pytest.mark.unit
@pytest.mark.asyncio
async def test_rpc_subscribe_accepts_exact_authorized_topics_and_unsubscribes() -> None:
    sent: list[dict] = []
    registry = MeshEventSubscriptionRegistry()
    handler = RPCHandler(
        AsyncMock(),
        AsyncMock(),
        lambda text: sent.append(json.loads(text)),
        lambda: _identity("TTS.use"),
        stable_peer_id_provider=lambda: "stable-peer",
        authenticated_peer_validator=lambda: True,
        event_subscription_registry=registry,
        peer_supports_capability=lambda cap: cap == CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1,
        event_topic_authorizer=lambda peer_id, topic, identity: (
            peer_id == "stable-peer" and topic == TTSMethods.STARTED
        ),
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "subscribe",
                "id": "sub-1",
                "topics": [TTSMethods.STARTED],
                "ttl_seconds": 30,
            }
        )
    )

    assert sent[-1] == {
        "type": "subscribed",
        "id": "sub-1",
        "subscription_id": "sub-1",
        "accepted": True,
        "accepted_topics": [TTSMethods.STARTED],
        "rejected_topics": [],
        "correlation_ids": [],
        "ttl_seconds": 30.0,
        "reason": None,
        "idempotent": False,
    }
    assert "expires_at" not in sent[-1]
    assert registry.is_interested("stable-peer", TTSMethods.STARTED) is True

    await handler.on_message(
        json.dumps(
            {
                "type": "unsubscribe",
                "id": "sub-1",
            }
        )
    )

    assert sent[-1]["type"] == "unsubscribed"
    assert sent[-1]["removed"] is True
    assert registry.is_interested("stable-peer", TTSMethods.STARTED) is False


@pytest.mark.unit
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message, expected_code",
    [
        ({"type": "subscribe", "id": "s1", "topics": ["TTS.*"]}, "parse_rejected"),
        ({"type": "subscribe", "id": "s1", "topics": [TTSMethods.STARTED]}, 426),
    ],
)
async def test_rpc_subscribe_rejects_wildcard_and_unnegotiated_without_mutation(
    message: dict, expected_code: int | str | None
) -> None:
    sent: list[dict] = []
    registry = MeshEventSubscriptionRegistry()
    negotiated = expected_code is None
    handler = RPCHandler(
        AsyncMock(),
        AsyncMock(),
        lambda text: sent.append(json.loads(text)),
        lambda: _identity("TTS.use"),
        stable_peer_id_provider=lambda: "stable-peer",
        authenticated_peer_validator=lambda: True,
        event_subscription_registry=registry,
        peer_supports_capability=lambda cap: negotiated
        and cap == CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1,
        event_topic_authorizer=lambda *_: True,
    )

    await handler.on_message(json.dumps(message))

    assert registry.snapshot().subscription_count == 0
    if expected_code == "parse_rejected":
        assert sent == []
    elif expected_code is None:
        assert sent[-1] == {
            "type": "subscribe_rejected",
            "id": "s1",
            "subscription_id": "s1",
            "accepted": False,
            "accepted_topics": [],
            "rejected_topics": [{"topic": "TTS.*", "reason": "malformed_topic"}],
            "correlation_ids": [],
            "ttl_seconds": None,
            "reason": "malformed_topic",
            "idempotent": False,
        }
        assert "expires_at" not in sent[-1]
    else:
        assert sent[-1]["type"] == "error"
        assert sent[-1]["error"]["code"] == expected_code


@pytest.mark.unit
@pytest.mark.asyncio
async def test_rpc_subscribe_rejects_anonymous_without_mutation() -> None:
    sent: list[dict] = []
    registry = MeshEventSubscriptionRegistry()
    handler = RPCHandler(
        AsyncMock(),
        AsyncMock(),
        lambda text: sent.append(json.loads(text)),
        lambda: _identity(principal_id="anonymous", source="anonymous"),
        stable_peer_id_provider=lambda: "stable-peer",
        event_subscription_registry=registry,
        peer_supports_capability=lambda cap: cap == CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1,
        event_topic_authorizer=lambda *_: True,
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "subscribe",
                "id": "sub-anon",
                "topics": [TTSMethods.STARTED],
            }
        )
    )

    assert sent[-1]["type"] == "error"
    assert sent[-1]["error"]["code"] == 401
    assert registry.snapshot().subscription_count == 0


@pytest.mark.unit
@pytest.mark.asyncio
async def test_rpc_local_consumer_rejects_inbound_service_call_with_405() -> None:
    sent: list[dict] = []
    bus = AsyncMock()
    registry = AsyncMock()
    registry.get_service.return_value = ServiceAnnouncement(
        module="TTS",
        version="1",
        methods=[
            MethodInfo(
                name="Started",
                bus_topic=TTSMethods.STARTED,
                exposure="external",
                required_perms=[],
                method_type="use",
            )
        ],
    )
    handler = RPCHandler(
        bus,
        registry,
        lambda text: sent.append(json.loads(text)),
        lambda: _identity("TTS.use"),
        local_peer_role_provider=lambda: "consumer",
    )

    await handler.on_message(
        json.dumps({"type": "call", "id": "call-1", "method": TTSMethods.STARTED, "params": {}})
    )

    assert sent[-1] == {
        "type": "error",
        "id": "call-1",
        "correlation_id": "call-1",
        "error": {"code": 405, "message": "Local peer is consumer-only"},
    }
    bus.request.assert_not_called()


@pytest.mark.unit
@pytest.mark.asyncio
async def test_peer_bridge_rejects_consumer_peer_outbound_call_and_stream() -> None:
    rtc = MagicMock()
    rtc.peer_protocol_role.return_value = "consumer"
    bridge = PeerBridge(rtc, MagicMock())

    result = await bridge.call("peer-consumer", TTSMethods.REQUEST, Payload())
    assert result.ok is False
    assert "consumer-only" in result.error
    rtc.send_to_peer.assert_not_called()

    with pytest.raises(PermissionError):
        async for _ in bridge.stream_call("peer-consumer", TTSMethods.REQUEST, Payload()):
            pass


@pytest.mark.unit
@pytest.mark.asyncio
async def test_peer_bridge_event_filtering_is_exact_and_sensitive_fail_closed() -> None:
    subscription_registry = MeshEventSubscriptionRegistry()
    subscription_registry.subscribe(
        peer_id="peer-a",
        subscription_id="sub-a",
        requested_topics=[TTSMethods.STARTED, TTSMethods.AUDIO_CHUNK],
        allowed_topics=[TTSMethods.STARTED, TTSMethods.AUDIO_CHUNK],
        correlation_ids=["corr-a"],
    )
    rtc = MagicMock()
    rtc.event_subscriptions = subscription_registry
    rtc.peer_supports_capability.side_effect = (
        lambda peer_id, cap: peer_id == "peer-a" and cap == CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1
    )
    rtc.send_to_peer_async = AsyncMock(return_value=True)
    bridge = PeerBridge(rtc, MagicMock())

    assert await bridge.fire_event_async("peer-a", TTSMethods.STARTED, Payload(), "corr-a") is True
    assert await bridge.fire_event_async("peer-a", TTSMethods.STARTED, Payload(), "corr-b") is False
    assert await bridge.fire_event_async("peer-b", TTSMethods.STARTED, Payload(), "corr-a") is True
    assert (
        await bridge.fire_event_async("peer-b", TTSMethods.AUDIO_CHUNK, Payload(), "corr-a")
        is False
    )

    sent = [json.loads(call.args[1]) for call in rtc.send_to_peer_async.call_args_list]
    assert [item["topic"] for item in sent] == [TTSMethods.STARTED, TTSMethods.STARTED]


@pytest.mark.unit
@pytest.mark.asyncio
async def test_legacy_event_broadcast_rollout_flag_disables_only_unscoped_compatibility() -> None:
    subscriptions = MeshEventSubscriptionRegistry()
    subscriptions.subscribe(
        peer_id="peer-scoped",
        subscription_id="sub-scoped",
        requested_topics=[TTSMethods.STARTED],
        allowed_topics=[TTSMethods.STARTED],
        correlation_ids=["corr-a"],
    )
    rtc = MagicMock()
    rtc.event_subscriptions = subscriptions
    rtc.peer_supports_capability.side_effect = (
        lambda peer_id, capability: peer_id == "peer-scoped"
        and capability == CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1
    )
    rtc.send_to_peer_async = AsyncMock(return_value=True)
    bridge = PeerBridge(rtc, MagicMock(), legacy_event_broadcast=False)

    assert (
        await bridge.fire_event_async("peer-scoped", TTSMethods.STARTED, Payload(), "corr-a")
        is True
    )
    assert (
        await bridge.fire_event_async("peer-legacy", TTSMethods.STARTED, Payload(), "corr-a")
        is False
    )
    assert (
        await bridge.fire_event_async("peer-legacy", TTSMethods.AUDIO_CHUNK, Payload(), "corr-a")
        is False
    )
    assert rtc.send_to_peer_async.await_count == 1

    bridge.set_legacy_event_broadcast(True)
    assert (
        await bridge.fire_event_async("peer-legacy", TTSMethods.STARTED, Payload(), "corr-a")
        is True
    )
    assert (
        await bridge.fire_event_async("peer-legacy", TTSMethods.AUDIO_CHUNK, Payload(), "corr-a")
        is False
    )
    assert rtc.send_to_peer_async.await_count == 2


@pytest.mark.unit
@pytest.mark.asyncio
async def test_targeted_assistant_events_route_only_to_targeted_scoped_interest() -> None:
    subscription_registry = MeshEventSubscriptionRegistry(clock=lambda: 1000.0)
    for peer_id, correlation_id in (("peer-a", "corr-a"), ("peer-b", "corr-b")):
        result = subscription_registry.subscribe(
            peer_id=peer_id,
            subscription_id=f"sub-{peer_id}",
            requested_topics=[OrchestratorMethods.RESPONSE, TTSMethods.AUDIO_CHUNK],
            allowed_topics=[OrchestratorMethods.RESPONSE, TTSMethods.AUDIO_CHUNK],
            correlation_ids=[correlation_id],
            ttl_seconds=60,
        )
        assert result.accepted is True

    rtc = MagicMock()
    rtc.event_subscriptions = subscription_registry
    rtc.peer_supports_capability.side_effect = (
        lambda _peer_id, cap: cap == CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1
    )
    rtc.send_to_peer_async = AsyncMock(return_value=True)
    bridge = PeerBridge(rtc, MagicMock())

    assert (
        await bridge.fire_event_async(
            "peer-a",
            OrchestratorMethods.RESPONSE,
            Payload(),
            "corr-a",
            target_peer_id="peer-a",
        )
        is True
    )
    assert (
        await bridge.fire_event_async(
            "peer-b",
            OrchestratorMethods.RESPONSE,
            Payload(),
            "corr-a",
            target_peer_id="peer-a",
        )
        is False
    )
    assert (
        await bridge.fire_event_async(
            "peer-a",
            OrchestratorMethods.RESPONSE,
            Payload(),
            "wrong",
            target_peer_id="peer-a",
        )
        is False
    )
    assert (
        await bridge.fire_event_async(
            "peer-a",
            OrchestratorMethods.RESPONSE,
            Payload(),
            None,
            target_peer_id="peer-a",
        )
        is False
    )
    assert (
        await bridge.fire_event_async(
            "peer-b",
            TTSMethods.AUDIO_CHUNK,
            Payload(),
            "corr-b",
            target_peer_id="peer-b",
        )
        is True
    )

    legacy = MagicMock()
    legacy.event_subscriptions = subscription_registry
    legacy.peer_supports_capability.return_value = False
    legacy.send_to_peer_async = AsyncMock(return_value=True)
    legacy_bridge = PeerBridge(legacy, MagicMock())
    assert (
        await legacy_bridge.fire_event_async(
            "peer-a",
            OrchestratorMethods.RESPONSE,
            Payload(),
            "corr-a",
            target_peer_id="peer-a",
        )
        is False
    )
    assert legacy.send_to_peer_async.await_count == 0

    sent = [json.loads(call.args[1]) for call in rtc.send_to_peer_async.call_args_list]
    assert [(item["topic"], item["correlation_id"]) for item in sent] == [
        (OrchestratorMethods.RESPONSE, "corr-a"),
        (TTSMethods.AUDIO_CHUNK, "corr-b"),
    ]


@pytest.mark.unit
@pytest.mark.asyncio
async def test_targeted_assistant_mesh_bus_skips_wrong_missing_target_and_stale_interest() -> None:
    inner = AsyncMock()
    routing = MagicMock()
    routing.get_negotiated_peers.return_value = [
        SimpleNamespace(peer_id="peer-a"),
        SimpleNamespace(peer_id="peer-b"),
    ]
    peer_bridge = MagicMock()
    peer_bridge.fire_event_async = AsyncMock(return_value=True)
    cfg = MeshConfig(
        enabled=True,
        node_name="node",
        services={
            "Orchestrator": mesh_policy(share=True),
            "TTS": mesh_policy(share=True),
        },
    )
    bus = MeshBus(inner, routing, peer_bridge, cfg)

    await bus.publish(
        OrchestratorMethods.RESPONSE,
        Payload(),
        event=True,
        mesh=True,
        correlation_id="corr-a",
        caller_peer_id="peer-a",
    )
    peer_bridge.fire_event_async.assert_awaited_once_with(
        "peer-a",
        OrchestratorMethods.RESPONSE,
        Payload(),
        correlation_id="corr-a",
        target_peer_id="peer-a",
    )

    peer_bridge.fire_event_async.reset_mock()
    await bus.publish(
        OrchestratorMethods.RESPONSE,
        Payload(),
        event=True,
        mesh=True,
        correlation_id="corr-a",
    )
    peer_bridge.fire_event_async.assert_not_awaited()

    await bus.publish(
        TTSMethods.AUDIO_CHUNK,
        Payload(),
        event=True,
        mesh=True,
        correlation_id="corr-b",
        caller_peer_id="peer-b",
    )
    peer_bridge.fire_event_async.assert_awaited_once_with(
        "peer-b",
        TTSMethods.AUDIO_CHUNK,
        Payload(),
        correlation_id="corr-b",
        target_peer_id="peer-b",
    )


@pytest.mark.unit
@pytest.mark.asyncio
async def test_subscription_interest_unsubscribe_disconnect_and_expiry_stop_delivery() -> None:
    registry = MeshEventSubscriptionRegistry(clock=lambda: 1000.0)
    accepted = registry.subscribe(
        peer_id="peer-a",
        subscription_id="sub-a",
        requested_topics=[OrchestratorMethods.RESPONSE],
        allowed_topics=[OrchestratorMethods.RESPONSE],
        correlation_ids=["corr-a"],
        ttl_seconds=10,
    )
    assert accepted.accepted is True
    rtc = MagicMock()
    rtc.event_subscriptions = registry
    rtc.peer_supports_capability.return_value = True
    rtc.send_to_peer_async = AsyncMock(return_value=True)
    bridge = PeerBridge(rtc, MagicMock())

    assert (
        await bridge.fire_event_async(
            "peer-a",
            OrchestratorMethods.RESPONSE,
            Payload(),
            "corr-a",
            target_peer_id="peer-a",
        )
        is True
    )
    registry.unsubscribe(peer_id="peer-a", subscription_id="sub-a")
    assert (
        await bridge.fire_event_async(
            "peer-a",
            OrchestratorMethods.RESPONSE,
            Payload(),
            "corr-a",
            target_peer_id="peer-a",
        )
        is False
    )

    registry.subscribe(
        peer_id="peer-a",
        subscription_id="sub-a",
        requested_topics=[OrchestratorMethods.RESPONSE],
        allowed_topics=[OrchestratorMethods.RESPONSE],
        correlation_ids=["corr-a"],
        ttl_seconds=10,
    )
    bridge.cleanup_peer("peer-a")
    assert (
        await bridge.fire_event_async(
            "peer-a",
            OrchestratorMethods.RESPONSE,
            Payload(),
            "corr-a",
            target_peer_id="peer-a",
        )
        is False
    )

    expiring_clock = {"now": 2000.0}
    expiring = MeshEventSubscriptionRegistry(clock=lambda: expiring_clock["now"])
    expiring.subscribe(
        peer_id="peer-a",
        subscription_id="sub-a",
        requested_topics=[OrchestratorMethods.RESPONSE],
        allowed_topics=[OrchestratorMethods.RESPONSE],
        correlation_ids=["corr-a"],
        ttl_seconds=1,
    )
    expiring_clock["now"] = 2002.0
    expired_rtc = MagicMock()
    expired_rtc.event_subscriptions = expiring
    expired_rtc.peer_supports_capability.return_value = True
    expired_rtc.send_to_peer_async = AsyncMock(return_value=True)
    expired_bridge = PeerBridge(expired_rtc, MagicMock())
    assert (
        await expired_bridge.fire_event_async(
            "peer-a",
            OrchestratorMethods.RESPONSE,
            Payload(),
            "corr-a",
            target_peer_id="peer-a",
        )
        is False
    )


@pytest.mark.unit
@pytest.mark.asyncio
async def test_production_rpc_subscribe_authorizes_targeted_assistant_topics() -> None:
    sent: list[dict] = []
    registry = MeshEventSubscriptionRegistry(clock=lambda: 1000.0)
    handler = RPCHandler(
        AsyncMock(),
        AsyncMock(),
        lambda text: sent.append(json.loads(text)),
        lambda: _identity("Orchestrator.use"),
        mesh_config=MeshConfig(
            enabled=True,
            node_name="node",
            services={
                "Orchestrator": mesh_policy(share=True),
                "TTS": mesh_policy(share=True),
            },
        ),
        stable_peer_id_provider=lambda: "stable-peer",
        authenticated_peer_validator=lambda: True,
        event_subscription_registry=registry,
        peer_supports_capability=lambda cap: cap == CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1,
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "subscribe",
                "id": "sub-assistant",
                "topics": [OrchestratorMethods.RESPONSE, TTSMethods.AUDIO_CHUNK],
                "correlation_ids": ["corr-a"],
                "ttl_seconds": 30,
            }
        )
    )

    assert sent[-1]["type"] == "subscribed"
    assert sent[-1]["accepted_topics"] == [OrchestratorMethods.RESPONSE, TTSMethods.AUDIO_CHUNK]
    assert registry.is_interested("stable-peer", OrchestratorMethods.RESPONSE, "corr-a") is True
    assert registry.is_interested("stable-peer", TTSMethods.AUDIO_CHUNK, "corr-a") is True


@pytest.mark.unit
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "perms, correlation_ids, reason",
    [
        ((), ["corr-a"], "unauthorized_topic"),
        (("Orchestrator.use",), [], "missing_correlation_id"),
    ],
)
async def test_production_rpc_subscribe_rejects_unauthorized_or_uncorrelated_targeted_topics(
    perms: tuple[str, ...], correlation_ids: list[str], reason: str
) -> None:
    sent: list[dict] = []
    registry = MeshEventSubscriptionRegistry()
    handler = RPCHandler(
        AsyncMock(),
        AsyncMock(),
        lambda text: sent.append(json.loads(text)),
        lambda: _identity(*perms),
        mesh_config=MeshConfig(
            enabled=True,
            node_name="node",
            services={
                "Orchestrator": mesh_policy(share=True),
                "TTS": mesh_policy(share=True),
            },
        ),
        stable_peer_id_provider=lambda: "stable-peer",
        authenticated_peer_validator=lambda: True,
        event_subscription_registry=registry,
        peer_supports_capability=lambda cap: cap == CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1,
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "subscribe",
                "id": "sub-assistant",
                "topics": [OrchestratorMethods.RESPONSE, TTSMethods.AUDIO_CHUNK],
                "correlation_ids": correlation_ids,
            }
        )
    )

    assert sent[-1]["type"] == "subscribe_rejected"
    assert sent[-1]["reason"] == reason
    assert registry.snapshot().subscription_count == 0


@pytest.mark.unit
@pytest.mark.asyncio
async def test_peer_bridge_async_send_falls_back_to_sync_and_cleanup_peer() -> None:
    rtc = MagicMock()
    rtc.send_to_peer.return_value = True
    rtc.peer_protocol_role.return_value = "hybrid"
    rtc.event_subscriptions = MeshEventSubscriptionRegistry()
    bridge = PeerBridge(rtc, MagicMock())

    async def respond() -> None:
        await asyncio.sleep(0.01)
        bridge.on_response("peer-1", {"type": "result", "id": "corr-1", "result": {"ok": True}})

    task = asyncio.create_task(respond())
    result = await bridge.call("peer-1", TTSMethods.REQUEST, Payload(), correlation_id="corr-1")
    await task
    assert result.ok is True
    rtc.send_to_peer.assert_called()

    rtc.event_subscriptions.subscribe(
        peer_id="peer-1",
        subscription_id="sub-1",
        requested_topics=[TTSMethods.STARTED],
        allowed_topics=[TTSMethods.STARTED],
    )
    bridge.cleanup_peer("peer-1")
    assert rtc.event_subscriptions.snapshot().subscription_count == 0


@pytest.mark.unit
@pytest.mark.asyncio
async def test_mesh_bus_awaits_async_peer_event_forwarder_before_send() -> None:
    inner = AsyncMock()
    routing = MagicMock()
    routing.get_negotiated_peers.return_value = [SimpleNamespace(peer_id="peer-1")]
    routing.resolve.return_value = RouteDecision(target="local", module="TTS")
    peer_bridge = MagicMock()
    peer_bridge.fire_event_async = AsyncMock(return_value=True)
    cfg = MeshConfig(
        enabled=True,
        node_name="node",
        services={"TTS": mesh_policy(share=True)},
    )
    bus = MeshBus(inner, routing, peer_bridge, cfg)

    await bus.publish(TTSMethods.STARTED, Payload(), event=True, mesh=True, correlation_id="corr")

    inner.publish.assert_awaited_once()
    peer_bridge.fire_event_async.assert_awaited_once_with(
        "peer-1", TTSMethods.STARTED, Payload(), correlation_id="corr"
    )
    peer_bridge.fire_event.assert_not_called()
