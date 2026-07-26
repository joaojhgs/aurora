"""Exact-topic WebRTC mesh event subscription registry.

The registry is intentionally authority-free: callers must validate permissions and
pass the authoritative set of topics a peer is allowed to subscribe to.  This
helper only stores exact-topic interests for authenticated stable peers and makes
routing decisions from that already-validated contract surface.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from math import isfinite
from time import monotonic

from app.shared.contracts.models.orchestrator import OrchestratorMethods
from app.shared.contracts.models.tts import TTSMethods

Clock = Callable[[], float]

DEFAULT_SUBSCRIPTION_TTL_SECONDS = 120.0
MAX_SUBSCRIPTION_TTL_SECONDS = 120.0
DEFAULT_MAX_TOPICS_PER_SUBSCRIPTION = 32
DEFAULT_MAX_SUBSCRIPTIONS_PER_PEER = 64
DEFAULT_MAX_CORRELATION_IDS_PER_SUBSCRIPTION = 32
MAX_PEER_ID_LENGTH = 128
MAX_SUBSCRIPTION_ID_LENGTH = 128
MAX_TOPIC_LENGTH = 256
MAX_CORRELATION_ID_LENGTH = 128

_REJECTED_EMPTY_PEER = "empty_peer_id"
_REJECTED_EMPTY_SUBSCRIPTION = "empty_subscription_id"
_REJECTED_MALFORMED_TOPIC = "malformed_topic"
_REJECTED_UNAUTHORIZED_TOPIC = "unauthorized_topic"
_REJECTED_TOPIC_CAP = "too_many_topics"
_REJECTED_PEER_CAP = "too_many_subscriptions_for_peer"
_REJECTED_CORRELATION_ID = "malformed_correlation_id"
_REJECTED_CORRELATION_CAP = "too_many_correlation_ids"
_REJECTED_CORRELATION_REQUIRED = "missing_correlation_id"
_REJECTED_TTL = "invalid_ttl"
_REJECTED_DUPLICATE_CONFLICT = "subscription_id_conflict"

CORRELATION_REQUIRED_EVENT_TOPICS = frozenset(
    {
        OrchestratorMethods.RESPONSE,
        TTSMethods.AUDIO_CHUNK,
    }
)


@dataclass(frozen=True)
class RejectedSubscriptionTopic:
    """Rejected topic request with a stable reason code."""

    topic: str
    reason: str


@dataclass(frozen=True)
class EventSubscription:
    """Stored exact-topic subscription for one authenticated stable peer."""

    peer_id: str
    subscription_id: str
    topics: frozenset[str]
    correlation_ids: frozenset[str] = field(default_factory=frozenset)
    expires_at: float = 0.0
    created_at: float = 0.0


@dataclass(frozen=True)
class SubscribeResult:
    """Structured subscribe outcome suitable for a wire-level ack frame."""

    accepted: bool
    peer_id: str
    subscription_id: str
    accepted_topics: tuple[str, ...] = ()
    rejected_topics: tuple[RejectedSubscriptionTopic, ...] = ()
    correlation_ids: tuple[str, ...] = ()
    expires_at: float | None = None
    ttl_seconds: float | None = None
    reason: str | None = None
    idempotent: bool = False


@dataclass(frozen=True)
class UnsubscribeResult:
    """Structured unsubscribe outcome."""

    peer_id: str
    subscription_id: str
    removed: bool


@dataclass(frozen=True)
class SubscriptionSnapshot:
    """Diagnostic snapshot with no topic/correlation secret detail."""

    peer_count: int
    subscription_count: int
    topic_interest_count: int
    expired_removed: int = 0


class MeshEventSubscriptionRegistry:
    """In-memory exact-topic subscription registry for WebRTC mesh events.

    The registry never grants authority.  It rejects any requested topic absent
    from ``allowed_topics`` and stores only exact strings: MQTT-style wildcards,
    globs, empty segments, and whitespace are rejected before mutation.
    """

    def __init__(
        self,
        *,
        clock: Clock | None = None,
        default_ttl_seconds: float = DEFAULT_SUBSCRIPTION_TTL_SECONDS,
        max_ttl_seconds: float = MAX_SUBSCRIPTION_TTL_SECONDS,
        max_topics_per_subscription: int = DEFAULT_MAX_TOPICS_PER_SUBSCRIPTION,
        max_subscriptions_per_peer: int = DEFAULT_MAX_SUBSCRIPTIONS_PER_PEER,
        max_correlation_ids_per_subscription: int = DEFAULT_MAX_CORRELATION_IDS_PER_SUBSCRIPTION,
        max_peer_id_length: int = MAX_PEER_ID_LENGTH,
        max_subscription_id_length: int = MAX_SUBSCRIPTION_ID_LENGTH,
        max_topic_length: int = MAX_TOPIC_LENGTH,
        max_correlation_id_length: int = MAX_CORRELATION_ID_LENGTH,
    ) -> None:
        if default_ttl_seconds <= 0 or max_ttl_seconds <= 0:
            raise ValueError("subscription TTL bounds must be positive")
        if (
            max_topics_per_subscription <= 0
            or max_subscriptions_per_peer <= 0
            or max_correlation_ids_per_subscription <= 0
        ):
            raise ValueError("subscription count bounds must be positive")
        if (
            max_peer_id_length <= 0
            or max_subscription_id_length <= 0
            or max_topic_length <= 0
            or max_correlation_id_length <= 0
        ):
            raise ValueError("subscription length bounds must be positive")
        self._clock = clock or monotonic
        self._default_ttl_seconds = min(float(default_ttl_seconds), float(max_ttl_seconds))
        self._max_ttl_seconds = float(max_ttl_seconds)
        self._max_topics_per_subscription = max_topics_per_subscription
        self._max_subscriptions_per_peer = max_subscriptions_per_peer
        self._max_correlation_ids_per_subscription = max_correlation_ids_per_subscription
        self._max_peer_id_length = max_peer_id_length
        self._max_subscription_id_length = max_subscription_id_length
        self._max_topic_length = max_topic_length
        self._max_correlation_id_length = max_correlation_id_length
        self._subscriptions: dict[tuple[str, str], EventSubscription] = {}
        self._subscriptions_by_peer: dict[str, set[str]] = defaultdict(set)

    def subscribe(
        self,
        *,
        peer_id: str,
        subscription_id: str,
        requested_topics: Iterable[str],
        allowed_topics: Iterable[str],
        correlation_ids: Iterable[str] | None = None,
        ttl_seconds: float | None = None,
    ) -> SubscribeResult:
        """Store an exact-topic subscription if all requested state is valid.

        Conflicting duplicate subscription IDs fail closed and leave existing
        state unchanged.  Identical active duplicate requests are idempotent and
        refresh no state.
        """

        now = self._clock()
        self.cleanup_expired(now=now)

        if not self._valid_identifier(peer_id, max_length=self._max_peer_id_length):
            return SubscribeResult(False, peer_id, subscription_id, reason=_REJECTED_EMPTY_PEER)
        if not self._valid_identifier(subscription_id, max_length=self._max_subscription_id_length):
            return SubscribeResult(
                False, peer_id, subscription_id, reason=_REJECTED_EMPTY_SUBSCRIPTION
            )

        requested = tuple(dict.fromkeys(requested_topics))
        allowed = frozenset(allowed_topics)
        requested_correlations = frozenset(correlation_ids or ())
        rejected = self._validate_topics(requested, allowed)

        if len(requested) > self._max_topics_per_subscription:
            return SubscribeResult(
                False,
                peer_id,
                subscription_id,
                rejected_topics=(
                    *rejected,
                    RejectedSubscriptionTopic("*", _REJECTED_TOPIC_CAP),
                ),
                reason=_REJECTED_TOPIC_CAP,
            )
        if not requested:
            return SubscribeResult(
                False, peer_id, subscription_id, reason=_REJECTED_MALFORMED_TOPIC
            )
        if rejected:
            return SubscribeResult(
                False,
                peer_id,
                subscription_id,
                rejected_topics=rejected,
                reason=rejected[0].reason,
            )
        correlation_required_topics = tuple(
            topic for topic in requested if topic in CORRELATION_REQUIRED_EVENT_TOPICS
        )
        if correlation_required_topics and not requested_correlations:
            return SubscribeResult(
                False,
                peer_id,
                subscription_id,
                rejected_topics=tuple(
                    RejectedSubscriptionTopic(topic, _REJECTED_CORRELATION_REQUIRED)
                    for topic in correlation_required_topics
                ),
                reason=_REJECTED_CORRELATION_REQUIRED,
            )
        if len(requested_correlations) > self._max_correlation_ids_per_subscription:
            return SubscribeResult(
                False, peer_id, subscription_id, reason=_REJECTED_CORRELATION_CAP
            )
        if any(
            not self._valid_identifier(value, max_length=self._max_correlation_id_length)
            for value in requested_correlations
        ):
            return SubscribeResult(False, peer_id, subscription_id, reason=_REJECTED_CORRELATION_ID)

        ttl = self._bounded_ttl(ttl_seconds)
        if ttl is None:
            return SubscribeResult(False, peer_id, subscription_id, reason=_REJECTED_TTL)
        expires_at = now + ttl
        key = (peer_id, subscription_id)
        subscription = EventSubscription(
            peer_id=peer_id,
            subscription_id=subscription_id,
            topics=frozenset(requested),
            correlation_ids=requested_correlations,
            expires_at=expires_at,
            created_at=now,
        )

        existing = self._subscriptions.get(key)
        if existing is not None:
            if self._same_interest(existing, subscription):
                return self._accepted_result(existing, idempotent=True)
            return SubscribeResult(
                False, peer_id, subscription_id, reason=_REJECTED_DUPLICATE_CONFLICT
            )

        peer_subscriptions = self._subscriptions_by_peer[peer_id]
        if len(peer_subscriptions) >= self._max_subscriptions_per_peer:
            return SubscribeResult(False, peer_id, subscription_id, reason=_REJECTED_PEER_CAP)

        self._subscriptions[key] = subscription
        peer_subscriptions.add(subscription_id)
        return self._accepted_result(subscription)

    def unsubscribe(self, *, peer_id: str, subscription_id: str) -> UnsubscribeResult:
        """Remove one subscription for one peer."""

        removed = self._remove(peer_id, subscription_id)
        return UnsubscribeResult(peer_id=peer_id, subscription_id=subscription_id, removed=removed)

    def cleanup_peer(self, peer_id: str) -> int:
        """Remove all subscriptions owned by ``peer_id`` and return count."""

        subscription_ids = tuple(self._subscriptions_by_peer.get(peer_id, ()))
        removed = 0
        for subscription_id in subscription_ids:
            if self._remove(peer_id, subscription_id):
                removed += 1
        self._subscriptions_by_peer.pop(peer_id, None)
        return removed

    def cleanup_expired(self, *, now: float | None = None) -> int:
        """Deterministically remove expired subscriptions and return count."""

        cutoff = self._clock() if now is None else now
        expired = [key for key, value in self._subscriptions.items() if value.expires_at <= cutoff]
        for peer_id, subscription_id in expired:
            self._remove(peer_id, subscription_id)
        return len(expired)

    def is_interested(
        self,
        peer_id: str,
        topic: str,
        correlation_id: str | None = None,
        *,
        sensitive: bool = False,
    ) -> bool:
        """Return whether a peer has an unexpired exact match for an event.

        ``sensitive`` is accepted to make call sites explicit.  This registry is
        intentionally fail-closed for both sensitive and non-sensitive events:
        absence of an exact subscription is always ``False``.
        """

        del sensitive
        now = self._clock()
        for subscription_id in tuple(self._subscriptions_by_peer.get(peer_id, ())):
            subscription = self._subscriptions.get((peer_id, subscription_id))
            if subscription is None:
                continue
            if subscription.expires_at <= now:
                self._remove(peer_id, subscription_id)
                continue
            if topic not in subscription.topics:
                continue
            if topic in CORRELATION_REQUIRED_EVENT_TOPICS and not correlation_id:
                continue
            if topic in CORRELATION_REQUIRED_EVENT_TOPICS and not subscription.correlation_ids:
                continue
            if subscription.correlation_ids and (
                correlation_id is None or correlation_id not in subscription.correlation_ids
            ):
                continue
            return True
        return False

    def snapshot(self) -> SubscriptionSnapshot:
        """Return bounded diagnostic counts after expiring stale entries."""

        expired_removed = self.cleanup_expired()
        return SubscriptionSnapshot(
            peer_count=len(self._subscriptions_by_peer),
            subscription_count=len(self._subscriptions),
            topic_interest_count=sum(len(item.topics) for item in self._subscriptions.values()),
            expired_removed=expired_removed,
        )

    def _accepted_result(
        self, subscription: EventSubscription, *, idempotent: bool = False
    ) -> SubscribeResult:
        return SubscribeResult(
            accepted=True,
            peer_id=subscription.peer_id,
            subscription_id=subscription.subscription_id,
            accepted_topics=tuple(sorted(subscription.topics)),
            correlation_ids=tuple(sorted(subscription.correlation_ids)),
            expires_at=subscription.expires_at,
            ttl_seconds=max(0.0, subscription.expires_at - self._clock()),
            idempotent=idempotent,
        )

    def _remove(self, peer_id: str, subscription_id: str) -> bool:
        key = (peer_id, subscription_id)
        removed = self._subscriptions.pop(key, None) is not None
        peer_subscriptions = self._subscriptions_by_peer.get(peer_id)
        if peer_subscriptions is not None:
            peer_subscriptions.discard(subscription_id)
            if not peer_subscriptions:
                self._subscriptions_by_peer.pop(peer_id, None)
        return removed

    def _bounded_ttl(self, ttl_seconds: float | None) -> float | None:
        try:
            ttl = self._default_ttl_seconds if ttl_seconds is None else float(ttl_seconds)
        except (TypeError, ValueError):
            return None
        if ttl <= 0 or not isfinite(ttl):
            return None
        return min(ttl, self._max_ttl_seconds)

    def _validate_topics(
        self,
        requested_topics: tuple[str, ...],
        allowed_topics: frozenset[str],
    ) -> tuple[RejectedSubscriptionTopic, ...]:
        rejected: list[RejectedSubscriptionTopic] = []
        for topic in requested_topics:
            if not self._valid_topic(topic, max_length=self._max_topic_length):
                rejected.append(RejectedSubscriptionTopic(str(topic), _REJECTED_MALFORMED_TOPIC))
            elif topic not in allowed_topics:
                rejected.append(RejectedSubscriptionTopic(topic, _REJECTED_UNAUTHORIZED_TOPIC))
        return tuple(rejected)

    @staticmethod
    def _same_interest(left: EventSubscription, right: EventSubscription) -> bool:
        return left.topics == right.topics and left.correlation_ids == right.correlation_ids

    @staticmethod
    def _valid_identifier(value: str, *, max_length: int) -> bool:
        return (
            isinstance(value, str)
            and bool(value.strip())
            and value == value.strip()
            and len(value) <= max_length
        )

    @staticmethod
    def _valid_topic(topic: str, *, max_length: int) -> bool:
        if not isinstance(topic, str):
            return False
        if not topic or topic != topic.strip() or len(topic) > max_length:
            return False
        if any(token in topic for token in ("*", "+", "#")):
            return False
        if any(ch.isspace() for ch in topic):
            return False
        parts = topic.split(".")
        return all(parts)
