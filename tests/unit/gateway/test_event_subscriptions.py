from __future__ import annotations

import pytest

from app.services.gateway.webrtc.event_subscriptions import MeshEventSubscriptionRegistry
from app.shared.contracts.models.orchestrator import OrchestratorMethods
from app.shared.contracts.models.tts import TTSMethods


class FakeClock:
    def __init__(self, value: float = 1000.0) -> None:
        self.value = value

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


ALLOWED_TOPICS = {
    "Orchestrator.AssistantDelta",
    "Orchestrator.AssistantDone",
    OrchestratorMethods.RESPONSE,
    TTSMethods.AUDIO_CHUNK,
}


@pytest.mark.unit
def test_accepts_exact_allowed_topics_and_returns_ack_shape() -> None:
    clock = FakeClock()
    registry = MeshEventSubscriptionRegistry(clock=clock)

    result = registry.subscribe(
        peer_id="peer-a",
        subscription_id="sub-1",
        requested_topics=[
            TTSMethods.AUDIO_CHUNK,
            "Orchestrator.AssistantDelta",
            TTSMethods.AUDIO_CHUNK,
        ],
        allowed_topics=ALLOWED_TOPICS,
        correlation_ids=["corr-1"],
        ttl_seconds=30,
    )

    assert result.accepted is True
    assert result.idempotent is False
    assert result.accepted_topics == ("Orchestrator.AssistantDelta", TTSMethods.AUDIO_CHUNK)
    assert result.correlation_ids == ("corr-1",)
    assert result.expires_at == 1030.0
    assert result.ttl_seconds == 30.0
    assert registry.snapshot().subscription_count == 1


@pytest.mark.unit
@pytest.mark.parametrize(
    "topic",
    ["", " ", "Gateway.*", "Gateway.+", "Gateway.#", "Gateway..Event", "Gateway Event"],
)
def test_rejects_empty_wildcard_and_malformed_topics_without_mutation(topic: str) -> None:
    registry = MeshEventSubscriptionRegistry(clock=FakeClock())

    result = registry.subscribe(
        peer_id="peer-a",
        subscription_id="sub-1",
        requested_topics=[topic],
        allowed_topics=ALLOWED_TOPICS | {topic},
    )

    assert result.accepted is False
    assert result.reason == "malformed_topic"
    assert result.rejected_topics[0].reason == "malformed_topic"
    assert registry.snapshot().subscription_count == 0


@pytest.mark.unit
def test_rejects_unauthorized_unshared_topic_before_state_mutation() -> None:
    registry = MeshEventSubscriptionRegistry(clock=FakeClock())

    result = registry.subscribe(
        peer_id="peer-a",
        subscription_id="sub-1",
        requested_topics=[TTSMethods.AUDIO_CHUNK, "DB.PrivateChanged"],
        allowed_topics={TTSMethods.AUDIO_CHUNK},
    )

    assert result.accepted is False
    assert result.reason == "unauthorized_topic"
    assert result.rejected_topics == (result.rejected_topics[0],)
    assert result.rejected_topics[0].topic == "DB.PrivateChanged"
    assert registry.snapshot().subscription_count == 0


@pytest.mark.unit
@pytest.mark.parametrize("topic", [OrchestratorMethods.RESPONSE, TTSMethods.AUDIO_CHUNK])
def test_targeted_assistant_topics_require_correlation_ids(topic: str) -> None:
    registry = MeshEventSubscriptionRegistry(clock=FakeClock())

    result = registry.subscribe(
        peer_id="peer-a",
        subscription_id="sub-1",
        requested_topics=[topic],
        allowed_topics={topic},
    )

    assert result.accepted is False
    assert result.reason == "missing_correlation_id"
    assert result.rejected_topics[0].topic == topic
    assert registry.snapshot().subscription_count == 0

    accepted = registry.subscribe(
        peer_id="peer-a",
        subscription_id="sub-1",
        requested_topics=[topic],
        allowed_topics={topic},
        correlation_ids=["corr-1"],
    )
    assert accepted.accepted is True
    assert registry.is_interested("peer-a", topic, None) is False
    assert registry.is_interested("peer-a", topic, "corr-1") is True


@pytest.mark.unit
def test_enforces_topic_and_peer_subscription_caps_fail_closed() -> None:
    registry = MeshEventSubscriptionRegistry(
        clock=FakeClock(),
        max_topics_per_subscription=2,
        max_subscriptions_per_peer=1,
    )

    too_many_topics = registry.subscribe(
        peer_id="peer-a",
        subscription_id="sub-1",
        requested_topics=["A.One", "B.Two", "C.Three"],
        allowed_topics={"A.One", "B.Two", "C.Three"},
    )
    assert too_many_topics.accepted is False
    assert too_many_topics.reason == "too_many_topics"
    assert registry.snapshot().subscription_count == 0

    accepted = registry.subscribe(
        peer_id="peer-a",
        subscription_id="sub-1",
        requested_topics=["A.One"],
        allowed_topics={"A.One"},
    )
    assert accepted.accepted is True

    too_many_subscriptions = registry.subscribe(
        peer_id="peer-a",
        subscription_id="sub-2",
        requested_topics=["B.Two"],
        allowed_topics={"B.Two"},
    )
    assert too_many_subscriptions.accepted is False
    assert too_many_subscriptions.reason == "too_many_subscriptions_for_peer"
    assert registry.snapshot().subscription_count == 1


@pytest.mark.unit
def test_correlation_filters_match_exactly_and_peer_state_is_isolated() -> None:
    registry = MeshEventSubscriptionRegistry(clock=FakeClock())
    registry.subscribe(
        peer_id="peer-a",
        subscription_id="sub-1",
        requested_topics=[TTSMethods.AUDIO_CHUNK],
        allowed_topics=ALLOWED_TOPICS,
        correlation_ids=["stream-a"],
    )
    registry.subscribe(
        peer_id="peer-b",
        subscription_id="sub-1",
        requested_topics=[TTSMethods.AUDIO_CHUNK],
        allowed_topics=ALLOWED_TOPICS,
        correlation_ids=["stream-b"],
    )

    assert registry.is_interested("peer-a", TTSMethods.AUDIO_CHUNK, "stream-a") is True
    assert registry.is_interested("peer-a", TTSMethods.AUDIO_CHUNK, "stream-b") is False
    assert registry.is_interested("peer-a", TTSMethods.AUDIO_CHUNK) is False
    assert (
        registry.is_interested("peer-b", TTSMethods.AUDIO_CHUNK, "stream-b", sensitive=True) is True
    )
    assert registry.is_interested("peer-c", TTSMethods.AUDIO_CHUNK, "stream-a") is False


@pytest.mark.unit
def test_subscription_without_correlation_accepts_any_event_correlation() -> None:
    registry = MeshEventSubscriptionRegistry(clock=FakeClock())
    registry.subscribe(
        peer_id="peer-a",
        subscription_id="sub-1",
        requested_topics=["Orchestrator.AssistantDone"],
        allowed_topics=ALLOWED_TOPICS,
    )

    assert registry.is_interested("peer-a", "Orchestrator.AssistantDone", None) is True
    assert registry.is_interested("peer-a", "Orchestrator.AssistantDone", "corr-any") is True
    assert registry.is_interested("peer-a", "Orchestrator.AssistantDelta", "corr-any") is False


@pytest.mark.unit
def test_unsubscribe_removes_only_matching_peer_subscription() -> None:
    registry = MeshEventSubscriptionRegistry(clock=FakeClock())
    for peer_id in ("peer-a", "peer-b"):
        registry.subscribe(
            peer_id=peer_id,
            subscription_id="sub-1",
            requested_topics=[TTSMethods.AUDIO_CHUNK],
            allowed_topics=ALLOWED_TOPICS,
            correlation_ids=[f"corr-{peer_id}"],
        )

    removed = registry.unsubscribe(peer_id="peer-a", subscription_id="sub-1")

    assert removed.removed is True
    assert registry.is_interested("peer-a", TTSMethods.AUDIO_CHUNK, "corr-peer-a") is False
    assert registry.is_interested("peer-b", TTSMethods.AUDIO_CHUNK, "corr-peer-b") is True
    assert registry.unsubscribe(peer_id="peer-a", subscription_id="sub-1").removed is False


@pytest.mark.unit
def test_expiry_is_deterministic_and_ttl_is_clamped_to_max() -> None:
    clock = FakeClock()
    registry = MeshEventSubscriptionRegistry(
        clock=clock, default_ttl_seconds=60, max_ttl_seconds=120
    )

    result = registry.subscribe(
        peer_id="peer-a",
        subscription_id="sub-1",
        requested_topics=[TTSMethods.AUDIO_CHUNK],
        allowed_topics=ALLOWED_TOPICS,
        correlation_ids=["corr-1"],
        ttl_seconds=500,
    )
    assert result.accepted is True
    assert result.expires_at == 1120.0

    clock.advance(119.9)
    assert registry.is_interested("peer-a", TTSMethods.AUDIO_CHUNK, "corr-1") is True
    clock.advance(0.1)
    assert registry.is_interested("peer-a", TTSMethods.AUDIO_CHUNK, "corr-1") is False
    assert registry.snapshot().subscription_count == 0


@pytest.mark.unit
def test_disconnect_cleanup_removes_all_peer_state() -> None:
    registry = MeshEventSubscriptionRegistry(clock=FakeClock())
    registry.subscribe(
        peer_id="peer-a",
        subscription_id="sub-1",
        requested_topics=[TTSMethods.AUDIO_CHUNK],
        allowed_topics=ALLOWED_TOPICS,
        correlation_ids=["corr-1"],
    )
    registry.subscribe(
        peer_id="peer-a",
        subscription_id="sub-2",
        requested_topics=["Orchestrator.AssistantDelta"],
        allowed_topics=ALLOWED_TOPICS,
    )

    assert registry.cleanup_peer("peer-a") == 2
    assert registry.snapshot().peer_count == 0
    assert registry.cleanup_peer("peer-a") == 0


@pytest.mark.unit
def test_duplicate_subscription_is_idempotent_only_for_same_interest() -> None:
    registry = MeshEventSubscriptionRegistry(clock=FakeClock())

    first = registry.subscribe(
        peer_id="peer-a",
        subscription_id="sub-1",
        requested_topics=[TTSMethods.AUDIO_CHUNK],
        allowed_topics=ALLOWED_TOPICS,
        correlation_ids=["corr-1"],
    )
    same = registry.subscribe(
        peer_id="peer-a",
        subscription_id="sub-1",
        requested_topics=[TTSMethods.AUDIO_CHUNK],
        allowed_topics=ALLOWED_TOPICS,
        correlation_ids=["corr-1"],
    )
    conflict = registry.subscribe(
        peer_id="peer-a",
        subscription_id="sub-1",
        requested_topics=["Orchestrator.AssistantDelta"],
        allowed_topics=ALLOWED_TOPICS,
        correlation_ids=["corr-1"],
    )

    assert first.accepted is True
    assert same.accepted is True
    assert same.idempotent is True
    assert conflict.accepted is False
    assert conflict.reason == "subscription_id_conflict"
    assert registry.is_interested("peer-a", TTSMethods.AUDIO_CHUNK, "corr-1") is True
    assert registry.is_interested("peer-a", "Orchestrator.AssistantDelta", "corr-1") is False


@pytest.mark.unit
def test_rejects_overlong_peer_subscription_topic_and_correlation_without_mutation() -> None:
    registry = MeshEventSubscriptionRegistry(
        clock=FakeClock(),
        max_peer_id_length=6,
        max_subscription_id_length=5,
        max_topic_length=8,
        max_correlation_id_length=6,
    )

    overlong_peer = registry.subscribe(
        peer_id="peer-too-long",
        subscription_id="sub-1",
        requested_topics=["A.Ok"],
        allowed_topics={"A.Ok"},
    )
    overlong_subscription = registry.subscribe(
        peer_id="peer-a",
        subscription_id="sub-too-long",
        requested_topics=["A.Ok"],
        allowed_topics={"A.Ok"},
    )
    overlong_topic = registry.subscribe(
        peer_id="peer-a",
        subscription_id="sub-1",
        requested_topics=["A.TopicTooLong"],
        allowed_topics={"A.TopicTooLong"},
    )
    overlong_correlation = registry.subscribe(
        peer_id="peer-a",
        subscription_id="sub-1",
        requested_topics=["A.Ok"],
        allowed_topics={"A.Ok"},
        correlation_ids=["corr-too-long"],
    )

    assert overlong_peer.accepted is False
    assert overlong_peer.reason == "empty_peer_id"
    assert overlong_subscription.accepted is False
    assert overlong_subscription.reason == "empty_subscription_id"
    assert overlong_topic.accepted is False
    assert overlong_topic.reason == "malformed_topic"
    assert overlong_correlation.accepted is False
    assert overlong_correlation.reason == "malformed_correlation_id"
    assert registry.snapshot().subscription_count == 0


@pytest.mark.unit
def test_rejects_over_cap_correlation_ids_without_mutation() -> None:
    registry = MeshEventSubscriptionRegistry(
        clock=FakeClock(), max_correlation_ids_per_subscription=2
    )

    result = registry.subscribe(
        peer_id="peer-a",
        subscription_id="sub-1",
        requested_topics=[TTSMethods.AUDIO_CHUNK],
        allowed_topics=ALLOWED_TOPICS,
        correlation_ids=["corr-1", "corr-2", "corr-3"],
    )

    assert result.accepted is False
    assert result.reason == "too_many_correlation_ids"
    assert registry.snapshot().subscription_count == 0


@pytest.mark.unit
@pytest.mark.parametrize("ttl", [float("nan"), float("inf"), float("-inf"), "nan", "inf", object()])
def test_rejects_non_finite_or_non_numeric_ttl_without_mutation(ttl: object) -> None:
    registry = MeshEventSubscriptionRegistry(clock=FakeClock())

    result = registry.subscribe(
        peer_id="peer-a",
        subscription_id="sub-1",
        requested_topics=[TTSMethods.AUDIO_CHUNK],
        allowed_topics=ALLOWED_TOPICS,
        correlation_ids=["corr-1"],
        ttl_seconds=ttl,  # type: ignore[arg-type]
    )

    assert result.accepted is False
    assert result.reason == "invalid_ttl"
    assert registry.snapshot().subscription_count == 0
