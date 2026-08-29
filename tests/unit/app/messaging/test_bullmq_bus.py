"""Unit tests for BullMQ bus implementation.

Tests verify that BullMQBus provides the same interface and behavior as LocalBus.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from pydantic import BaseModel

from app.messaging.bullmq_bus import BullMQBus
from app.messaging.bus import QueryResult


class SampleMessage(BaseModel):
    """Test message payload."""

    content: str
    value: int = 42


class SampleResponse(BaseModel):
    """Test response payload."""

    ok: bool
    data: str


class FakeRedis:
    """Minimal Redis async client for BullMQ event fanout tests."""

    def __init__(self, subscribers=None, *, fail_sadd: bool = False, pubsub=None):
        self.subscribers = subscribers or set()
        self.published = []
        self.added = []
        self.removed = []
        self.fail_sadd = fail_sadd
        self._pubsub = pubsub

    async def smembers(self, key):
        return self.subscribers

    async def sadd(self, key, value):
        if self.fail_sadd:
            raise RuntimeError("sadd failed")
        self.added.append((key, value))
        return 1

    async def srem(self, key, value):
        self.removed.append((key, value))
        return 1

    async def publish(self, topic, payload):
        self.published.append((topic, payload))

    def pubsub(self):
        return self._pubsub


class FakePubSub:
    """Minimal Redis pubsub object for event readiness tests."""

    def __init__(self, *, fail_psubscribe: bool = False):
        self.patterns = []
        self.channels = []
        self.fail_psubscribe = fail_psubscribe

    async def psubscribe(self, topic):
        if self.fail_psubscribe:
            raise RuntimeError("psubscribe failed")
        self.patterns.append(topic)

    async def subscribe(self, topic):
        self.channels.append(topic)

    async def listen(self):
        if False:
            yield None


@pytest.fixture
def mock_bullmq():
    """Mock BullMQ dependencies."""
    # Create mock instances
    queue_instance = MagicMock()
    queue_instance.add = AsyncMock()
    queue_instance.close = AsyncMock()

    worker_instance = MagicMock()
    worker_instance.close = AsyncMock()
    worker_instance.on = MagicMock()

    events_instance = MagicMock()

    # Create mock classes
    mock_queue = MagicMock(return_value=queue_instance)
    mock_worker = MagicMock(return_value=worker_instance)
    mock_events = MagicMock(return_value=events_instance)

    # Patch the bullmq module before it's imported
    mock_bullmq_module = MagicMock()
    mock_bullmq_module.Queue = mock_queue
    mock_bullmq_module.Worker = mock_worker
    mock_bullmq_module.QueueEvents = mock_events

    with patch.dict("sys.modules", {"bullmq": mock_bullmq_module}):
        yield {
            "Queue": mock_queue,
            "Worker": mock_worker,
            "QueueEvents": mock_events,
            "queue_instance": queue_instance,
            "worker_instance": worker_instance,
        }


@pytest.mark.asyncio
class TestBullMQBusInterface:
    """Test BullMQBus implements the same interface as LocalBus."""

    async def test_init_with_validation(self):
        """Test initialization with topic validation enabled."""
        bus = BullMQBus(redis_url="redis://localhost:6379", validate_topics=True)
        assert bus._validate_topics is True
        assert bus.redis_url == "redis://localhost:6379"
        assert bus._stats["published"] == 0
        assert bus._stats["delivered"] == 0
        assert bus._stats["retries"] == 0
        assert bus._stats["dead_letters"] == 0

    async def test_init_without_validation(self):
        """Test initialization with topic validation disabled."""
        bus = BullMQBus(validate_topics=False)
        assert bus._validate_topics is False

    async def test_start_stop_lifecycle(self, mock_bullmq):
        """Test start and stop methods."""
        bus = BullMQBus()
        bus._available = True
        bus._Queue = mock_bullmq["Queue"]
        bus._Worker = mock_bullmq["Worker"]

        await bus.start()
        assert bus._started is True

        await bus.stop()
        assert bus._started is False

    async def test_start_registers_existing_event_subscriptions(self, mock_bullmq):
        """Event handlers subscribed before start get fanout queues on start."""
        bus = BullMQBus(validate_topics=True)
        bus._available = True
        bus._Queue = mock_bullmq["Queue"]
        bus._Worker = mock_bullmq["Worker"]
        bus._register_event_queue_ready = AsyncMock()

        handler = AsyncMock()
        bus.subscribe("Config.Updated", handler)
        assert "Config.Updated" not in bus._event_worker_queues

        await bus.start()

        assert "Config.Updated" in bus._event_worker_queues
        bus._register_event_queue_ready.assert_awaited_once()
        mock_bullmq["Worker"].assert_called()

    async def test_start_rolls_back_started_flag_on_event_readiness_failure(self, mock_bullmq):
        """start() must not report running when pre-start event readiness fails."""
        bus = BullMQBus(validate_topics=False)
        bus._available = True
        bus._Queue = mock_bullmq["Queue"]
        bus._Worker = mock_bullmq["Worker"]
        bus._register_event_queue_ready = AsyncMock(side_effect=RuntimeError("sadd failed"))

        handler = AsyncMock()
        bus.subscribe("AuroraTest.Bullmq.Start.Fail", handler, event=True)

        with pytest.raises(RuntimeError, match="sadd failed"):
            await bus.start()

        assert bus._started is False

    async def test_validation_disabled_direct_topic_uses_command_queue(self):
        """Validation-disabled concrete topics are commands, not event fanout."""
        bus = BullMQBus(validate_topics=False)

        assert bus._is_event_topic("AuroraTest.Bullmq.Dynamic.Ping") is False
        assert bus._is_event_topic("AuroraTest.Bullmq.Dynamic.*") is False
        assert bus._is_event_topic("AuroraTest.Bullmq.Dynamic.Ping", event=True) is True
        assert bus._is_event_topic("reply.SampleMessage.123", event=True) is False

    async def test_validation_disabled_explicit_event_registers_fanout(self, mock_bullmq):
        """Explicit event subscriptions use fanout even when contract validation is disabled."""
        bus = BullMQBus(validate_topics=False)
        bus._available = True
        bus._Queue = mock_bullmq["Queue"]
        bus._Worker = mock_bullmq["Worker"]
        bus._register_event_queue_ready = AsyncMock()

        await bus.start()

        handler = AsyncMock()
        bus.subscribe("AuroraTest.Bullmq.Dynamic.Event", handler, event=True)

        assert "AuroraTest.Bullmq.Dynamic.Event" in bus._event_handlers
        assert "AuroraTest.Bullmq.Dynamic.Event" not in bus._handlers
        assert "AuroraTest.Bullmq.Dynamic.Event" in bus._event_worker_queues
        mock_bullmq["Worker"].assert_called()

    async def test_subscribe_event_awaits_exact_registration(self, mock_bullmq):
        """subscribe_event waits until the exact event queue is registered in Redis."""
        bus = BullMQBus(validate_topics=False)
        bus._available = True
        bus._Queue = mock_bullmq["Queue"]
        bus._Worker = mock_bullmq["Worker"]
        bus._redis = FakeRedis()
        await bus.start()

        handler = AsyncMock()
        await bus.subscribe_event("AuroraTest.Bullmq.Dynamic.Ready", handler)

        queue_name = bus._event_worker_queues["AuroraTest.Bullmq.Dynamic.Ready"]
        assert bus._redis.added == [
            ("aurora:event-subscribers:AuroraTest.Bullmq.Dynamic.Ready", queue_name)
        ]
        assert handler in bus._event_handlers["AuroraTest.Bullmq.Dynamic.Ready"]

    async def test_subscribe_event_exact_failure_cleans_up_handler_and_ready_state(
        self, mock_bullmq
    ):
        """Failed exact event readiness removes the appended handler and queue state."""
        bus = BullMQBus(validate_topics=False)
        bus._available = True
        bus._Queue = mock_bullmq["Queue"]
        bus._Worker = mock_bullmq["Worker"]
        bus._redis = FakeRedis(fail_sadd=True)
        await bus.start()

        handler = AsyncMock()
        with pytest.raises(RuntimeError, match="sadd failed"):
            await bus.subscribe_event("AuroraTest.Bullmq.Dynamic.Fail", handler)

        assert "AuroraTest.Bullmq.Dynamic.Fail" not in bus._event_handlers
        assert "AuroraTest.Bullmq.Dynamic.Fail" not in bus._event_worker_queues
        assert not any(
            name.startswith("event.AuroraTest.Bullmq.Dynamic.Fail") for name in bus._workers
        )

    async def test_subscribe_event_wildcard_failure_cleans_up_handler_and_ready_state(
        self, mock_bullmq
    ):
        """Failed wildcard pub/sub readiness removes handler and pattern state."""
        bus = BullMQBus(validate_topics=False)
        bus._available = True
        bus._Queue = mock_bullmq["Queue"]
        bus._Worker = mock_bullmq["Worker"]
        bus._redis = FakeRedis(pubsub=FakePubSub(fail_psubscribe=True))
        await bus.start()

        handler = AsyncMock()
        with pytest.raises(RuntimeError, match="psubscribe failed"):
            await bus.subscribe_event("AuroraTest.Bullmq.Dynamic.*", handler)

        assert "AuroraTest.Bullmq.Dynamic.*" not in bus._event_wildcard_patterns
        assert "AuroraTest.Bullmq.Dynamic.*" not in bus._event_patterns

    async def test_subscribe_event_waits_for_pending_sync_wildcard_readiness(self, mock_bullmq):
        """Awaited wildcard subscriptions do not treat pending sync psubscribe as ready."""
        bus = BullMQBus(validate_topics=False)
        bus._available = True
        bus._Queue = mock_bullmq["Queue"]
        bus._Worker = mock_bullmq["Worker"]
        await bus.start()
        ready_to_complete = asyncio.Event()

        async def slow_subscribe(topic: str, *, pattern: bool) -> None:
            await ready_to_complete.wait()

        bus._subscribe_event_topic_ready = AsyncMock(side_effect=slow_subscribe)
        first_handler = AsyncMock()
        second_handler = AsyncMock()

        bus.subscribe("AuroraTest.Bullmq.Pending.*", first_handler, event=True)
        await asyncio.sleep(0)

        assert "AuroraTest.Bullmq.Pending.*" in bus._event_pattern_tasks
        assert "AuroraTest.Bullmq.Pending.*" not in bus._event_patterns

        subscribe_task = asyncio.create_task(
            bus.subscribe_event("AuroraTest.Bullmq.Pending.*", second_handler)
        )
        await asyncio.sleep(0)

        assert not subscribe_task.done()

        ready_to_complete.set()
        await subscribe_task

        assert "AuroraTest.Bullmq.Pending.*" in bus._event_patterns
        assert bus._subscribe_event_topic_ready.await_count == 1

    async def test_concurrent_subscribe_event_wildcards_share_readiness(self, mock_bullmq):
        """Concurrent awaited wildcard subscriptions perform one psubscribe."""
        bus = BullMQBus(validate_topics=False)
        bus._available = True
        bus._Queue = mock_bullmq["Queue"]
        bus._Worker = mock_bullmq["Worker"]
        await bus.start()
        readiness_started = asyncio.Event()
        release_readiness = asyncio.Event()
        subscribe_calls = 0

        async def slow_subscribe(topic: str, *, pattern: bool) -> None:
            nonlocal subscribe_calls
            subscribe_calls += 1
            readiness_started.set()
            await release_readiness.wait()

        bus._subscribe_event_topic_ready = AsyncMock(side_effect=slow_subscribe)
        first_handler = AsyncMock()
        second_handler = AsyncMock()

        first_task = asyncio.create_task(
            bus.subscribe_event("AuroraTest.Bullmq.Concurrent.*", first_handler)
        )
        await readiness_started.wait()
        second_task = asyncio.create_task(
            bus.subscribe_event("AuroraTest.Bullmq.Concurrent.*", second_handler)
        )
        await asyncio.sleep(0)

        assert subscribe_calls == 1
        assert not first_task.done()
        assert not second_task.done()

        release_readiness.set()
        await asyncio.gather(first_task, second_task)

        assert "AuroraTest.Bullmq.Concurrent.*" in bus._event_patterns
        assert subscribe_calls == 1

    async def test_concurrent_subscribe_event_wildcard_failure_does_not_clear_success(
        self, mock_bullmq
    ):
        """A failed wildcard waiter does not remove another waiter's ready state."""
        bus = BullMQBus(validate_topics=False)
        bus._available = True
        bus._Queue = mock_bullmq["Queue"]
        bus._Worker = mock_bullmq["Worker"]
        await bus.start()
        calls = 0

        async def fail_then_succeed(topic: str, *, pattern: bool) -> None:
            nonlocal calls
            calls += 1
            if calls == 1:
                raise RuntimeError("psubscribe failed")

        bus._subscribe_event_topic_ready = AsyncMock(side_effect=fail_then_succeed)
        first_handler = AsyncMock()
        second_handler = AsyncMock()

        results = await asyncio.gather(
            bus.subscribe_event("AuroraTest.Bullmq.Recover.*", first_handler),
            bus.subscribe_event("AuroraTest.Bullmq.Recover.*", second_handler),
            return_exceptions=True,
        )

        assert [type(result) for result in results].count(RuntimeError) == 1
        assert any(result is None for result in results)
        assert "AuroraTest.Bullmq.Recover.*" in bus._event_patterns
        handlers = bus._event_wildcard_patterns["AuroraTest.Bullmq.Recover.*"]
        if isinstance(results[0], RuntimeError):
            assert first_handler not in handlers
            assert second_handler in handlers
        else:
            assert second_handler not in handlers
            assert first_handler in handlers

    async def test_subscribe_direct_topic(self, mock_bullmq):
        """Test subscribing to a direct topic (no wildcards)."""
        bus = BullMQBus(validate_topics=False)
        bus._available = True
        bus._Queue = mock_bullmq["Queue"]
        bus._Worker = mock_bullmq["Worker"]
        bus._is_event_topic = MagicMock(return_value=False)

        handler = AsyncMock()
        bus.subscribe("TTS.Request", handler)

        assert "TTS.Request" in bus._handlers
        assert handler in bus._handlers["TTS.Request"]
        assert "TTS.Request" in bus._workers

    async def test_subscribe_event_topic(self, mock_bullmq):
        """Test subscribing to a broadcast event topic."""
        bus = BullMQBus(validate_topics=True)
        bus._available = True
        bus._Queue = mock_bullmq["Queue"]
        bus._Worker = mock_bullmq["Worker"]

        handler = AsyncMock()
        bus.subscribe("Config.Updated", handler, event=True)

        assert "Config.Updated" in bus._event_handlers
        assert handler in bus._event_handlers["Config.Updated"]
        assert "Config.Updated" not in bus._handlers

    async def test_subscribe_wildcard_topic(self, mock_bullmq):
        """Test subscribing to a wildcard topic pattern."""
        bus = BullMQBus(validate_topics=False)
        bus._available = True
        bus._Queue = mock_bullmq["Queue"]
        bus._Worker = mock_bullmq["Worker"]
        bus._is_event_topic = MagicMock(return_value=False)

        handler = AsyncMock()
        bus.subscribe("TTS.*", handler)

        assert "TTS.*" in bus._wildcard_patterns
        assert handler in bus._wildcard_patterns["TTS.*"]
        assert "TTS" in bus._workers

    async def test_topic_matches(self):
        """Test topic matching logic."""
        bus = BullMQBus()

        # Exact match
        assert bus._topic_matches("TTS.Request", "TTS.Request") is True

        # Wildcard match
        assert bus._topic_matches("TTS.Request", "TTS.*") is True
        assert bus._topic_matches("TTS.Response", "TTS.*") is True

        # No match
        assert bus._topic_matches("STT.Request", "TTS.*") is False
        assert bus._topic_matches("TTS", "TTS.*") is False

    async def test_publish_with_validation(self, mock_bullmq):
        """Test publishing with topic validation."""
        bus = BullMQBus(validate_topics=False)
        bus._available = True
        bus._Queue = mock_bullmq["Queue"]
        bus._Worker = mock_bullmq["Worker"]

        message = SampleMessage(content="test", value=100)

        await bus.publish(
            "TTS.Request",
            message,
            event=False,
            priority=10,
            origin="test",
            reliable=True,
            ttl_ms=5000,
            max_attempts=3,
        )

        assert bus._stats["published"] == 1
        mock_bullmq["queue_instance"].add.assert_called_once()

    async def test_publish_event_fanout(self, mock_bullmq):
        """Broadcast events are copied to each durable subscriber queue."""
        bus = BullMQBus(validate_topics=False)
        bus._available = True
        bus._Queue = mock_bullmq["Queue"]
        bus._Worker = mock_bullmq["Worker"]
        bus._redis = FakeRedis(
            subscribers={b"event.Config.Updated.worker1", "event.Config.Updated.worker2"}
        )

        message = SampleMessage(content="test")

        await bus.publish("Config.Updated", message, event=True)

        assert bus._stats["published"] == 1
        assert mock_bullmq["queue_instance"].add.call_count == 2
        assert len(bus._redis.published) == 1
        assert bus._redis.published[0][0] == "Config.Updated"

    async def test_publish_with_reply_to(self, mock_bullmq):
        """Test publishing with reply_to parameter."""
        bus = BullMQBus(validate_topics=False)
        bus._available = True
        bus._Queue = mock_bullmq["Queue"]
        bus._Worker = mock_bullmq["Worker"]

        message = SampleMessage(content="test")

        await bus.publish(
            "TTS.Request",
            message,
            event=False,
            reply_to="reply.TTS.123",
            transport_source_id="opaque-http-source",
        )

        call_args = mock_bullmq["queue_instance"].add.call_args
        job_data = call_args[0][1]
        assert job_data["reply_to"] == "reply.TTS.123"
        assert job_data["transport_source_id"] == "opaque-http-source"

    async def test_publish_with_correlation_id(self, mock_bullmq):
        """Reply jobs must carry correlation_id for request/response matching."""
        bus = BullMQBus(validate_topics=False)
        bus._available = True
        bus._Queue = mock_bullmq["Queue"]
        bus._Worker = mock_bullmq["Worker"]

        message = SampleMessage(content="test")

        await bus.publish(
            "reply.SampleMessage.abc-123",
            message,
            event=False,
            correlation_id="abc-123",
        )

        call_args = mock_bullmq["queue_instance"].add.call_args
        job_data = call_args[0][1]
        assert job_data["correlation_id"] == "abc-123"

    async def test_request_response_pattern(self, mock_bullmq):
        """Test request/response pattern."""
        bus = BullMQBus(validate_topics=False)
        bus._available = True
        bus._Queue = mock_bullmq["Queue"]
        bus._Worker = mock_bullmq["Worker"]

        message = SampleMessage(content="request")

        # Mock the response by simulating a future resolution
        async def mock_request():
            # Create the request
            task = asyncio.create_task(
                bus.request(
                    "TTS.Request",
                    message,
                    priority=10,
                    timeout=1.0,
                )
            )

            # Give time for subscription to happen
            await asyncio.sleep(0.1)

            # Simulate timeout
            await asyncio.sleep(1.1)

            result = await task
            return result

        result = await mock_request()

        # Should timeout and return error
        assert result.ok is False
        assert "timeout" in result.error.lower()

        # Ephemeral reply worker must be torn down (EMFILE fix — phase 1)
        reply_workers = [k for k in bus._workers if k.startswith("reply.")]
        assert reply_workers == []
        mock_bullmq["worker_instance"].close.assert_called()

    async def test_request_preserves_projected_method_set_authority(self, mock_bullmq):
        """Tooling projection evidence must survive request-to-publish forwarding."""
        bus = BullMQBus(validate_topics=False)
        bus._available = True
        bus._Queue = mock_bullmq["Queue"]
        bus._Worker = mock_bullmq["Worker"]

        result = await bus.request(
            "Tooling.GetExportCatalog",
            SampleMessage(content="projection"),
            timeout=0.01,
            projected_method_topics=[
                "Tooling.ExecuteTool",
                "Tooling.GetExportCatalog",
            ],
            projected_method_set_digest="projection-digest",
        )

        assert result.ok is False
        job_data = mock_bullmq["queue_instance"].add.await_args.args[1]
        assert job_data["projected_method_topics"] == [
            "Tooling.ExecuteTool",
            "Tooling.GetExportCatalog",
        ]
        assert job_data["projected_method_set_digest"] == "projection-digest"

    async def test_request_teardown_skips_when_handlers_remain(self, mock_bullmq):
        """Do not close worker if another handler is still subscribed to the reply topic."""
        bus = BullMQBus(validate_topics=False)
        bus._available = True
        bus._Queue = mock_bullmq["Queue"]
        bus._Worker = mock_bullmq["Worker"]

        other = AsyncMock()
        reply_topic = "reply.SampleMessage.keep-me"

        bus.subscribe(reply_topic, other)
        mock_bullmq["Worker"].reset_mock()
        mock_bullmq["worker_instance"].close.reset_mock()

        await bus._async_teardown_topic(reply_topic)

        assert reply_topic in bus._workers
        mock_bullmq["worker_instance"].close.assert_not_called()

        bus.unsubscribe(reply_topic, other)
        await bus._async_teardown_topic(reply_topic)

        assert reply_topic not in bus._workers
        mock_bullmq["worker_instance"].close.assert_called()

    async def test_publish_closes_ephemeral_reply_queue(self, mock_bullmq):
        """Publishing to reply.* must not leave Queue clients in _queues forever."""
        bus = BullMQBus(validate_topics=False)
        bus._available = True
        bus._Queue = mock_bullmq["Queue"]
        bus._Worker = mock_bullmq["Worker"]

        message = SampleMessage(content="reply-body")
        topic = "reply.SampleMessage.test-uuid"

        await bus.publish(topic, message, event=False, correlation_id="test-uuid")

        assert topic not in bus._queues
        mock_bullmq["queue_instance"].close.assert_called()

    async def test_event_flag_on_reply_topic_uses_direct_queue(self, mock_bullmq):
        """Service-style event=True replies must reach request()'s direct Worker."""
        bus = BullMQBus(validate_topics=False)
        bus._available = True
        bus._Queue = mock_bullmq["Queue"]
        bus._Worker = mock_bullmq["Worker"]

        await bus.publish(
            "reply.SampleMessage.service-style",
            QueryResult(ok=True, data={"ok": True}),
            event=True,
            correlation_id="service-style",
        )

        mock_bullmq["queue_instance"].add.assert_awaited_once()
        job_data = mock_bullmq["queue_instance"].add.await_args.args[1]
        assert job_data["correlation_id"] == "service-style"

    async def test_multiple_requests_do_not_accumulate_reply_workers(self, mock_bullmq):
        """Each timed-out request must drop its reply.* worker."""
        bus = BullMQBus(validate_topics=False)
        bus._available = True
        bus._Queue = mock_bullmq["Queue"]
        bus._Worker = mock_bullmq["Worker"]

        message = SampleMessage(content="x")
        for _ in range(5):
            result = await bus.request(
                "TTS.Request",
                message,
                priority=10,
                timeout=0.01,
            )
            assert result.ok is False

        assert not any(k.startswith("reply.") for k in bus._workers)

    async def test_get_stats(self):
        """Test get_stats method returns correct statistics."""
        bus = BullMQBus()

        stats = bus.get_stats()

        assert "published" in stats
        assert "delivered" in stats
        assert "retries" in stats
        assert "dead_letters" in stats
        assert stats["published"] == 0
        assert stats["delivered"] == 0

    async def test_stats_increment_on_publish(self, mock_bullmq):
        """Test statistics increment on publish."""
        bus = BullMQBus(validate_topics=False)
        bus._available = True
        bus._Queue = mock_bullmq["Queue"]
        bus._Worker = mock_bullmq["Worker"]

        message = SampleMessage(content="test")

        await bus.publish("TTS.Request", message, event=False)
        assert bus._stats["published"] == 1

        await bus.publish("TTS.Request", message, event=False)
        assert bus._stats["published"] == 2

    async def test_multiple_handlers_same_topic(self, mock_bullmq):
        """Test multiple handlers can subscribe to the same topic."""
        bus = BullMQBus(validate_topics=False)
        bus._available = True
        bus._Queue = mock_bullmq["Queue"]
        bus._Worker = mock_bullmq["Worker"]
        bus._is_event_topic = MagicMock(return_value=False)

        handler1 = AsyncMock()
        handler2 = AsyncMock()

        bus.subscribe("TTS.Request", handler1)
        bus.subscribe("TTS.Request", handler2)

        assert len(bus._handlers["TTS.Request"]) == 2
        assert handler1 in bus._handlers["TTS.Request"]
        assert handler2 in bus._handlers["TTS.Request"]

    async def test_wildcard_and_direct_subscription(self, mock_bullmq):
        """Test mixing wildcard and direct subscriptions."""
        bus = BullMQBus(validate_topics=False)
        bus._available = True
        bus._Queue = mock_bullmq["Queue"]
        bus._Worker = mock_bullmq["Worker"]
        bus._is_event_topic = MagicMock(return_value=False)

        direct_handler = AsyncMock()
        wildcard_handler = AsyncMock()

        bus.subscribe("TTS.Request", direct_handler)
        bus.subscribe("TTS.*", wildcard_handler)

        assert "TTS.Request" in bus._handlers
        assert "TTS.*" in bus._wildcard_patterns


@pytest.mark.asyncio
class TestBullMQBusCompatibility:
    """Test BullMQBus compatibility with LocalBus interface."""

    async def test_has_same_methods_as_localbus(self):
        """Verify BullMQBus has all the same public methods as LocalBus."""
        from app.messaging.local_bus import LocalBus  # noqa: F401

        bullmq_methods = {
            name
            for name in dir(BullMQBus)
            if not name.startswith("_") and callable(getattr(BullMQBus, name))
        }

        # Check all public methods exist
        assert "start" in bullmq_methods
        assert "stop" in bullmq_methods
        assert "publish" in bullmq_methods
        assert "subscribe" in bullmq_methods
        assert "request" in bullmq_methods
        assert "get_stats" in bullmq_methods

    async def test_publish_signature_matches(self):
        """Verify publish method signature matches LocalBus."""
        import inspect

        from app.messaging.local_bus import LocalBus

        local_sig = inspect.signature(LocalBus.publish)
        bullmq_sig = inspect.signature(BullMQBus.publish)

        # Both should have the same parameters
        local_params = set(local_sig.parameters.keys())
        bullmq_params = set(bullmq_sig.parameters.keys())

        # reply_to is added to BullMQBus
        assert local_params.issubset(bullmq_params)

    async def test_request_signature_matches(self):
        """Verify request method signature matches LocalBus."""
        import inspect

        from app.messaging.local_bus import LocalBus

        local_sig = inspect.signature(LocalBus.request)
        bullmq_sig = inspect.signature(BullMQBus.request)

        # Both should have the same parameters
        assert set(local_sig.parameters.keys()) == set(bullmq_sig.parameters.keys())

    async def test_subscribe_signature_matches(self):
        """Verify subscribe method signature matches LocalBus."""
        import inspect

        from app.messaging.local_bus import LocalBus

        local_sig = inspect.signature(LocalBus.subscribe)
        bullmq_sig = inspect.signature(BullMQBus.subscribe)

        assert set(local_sig.parameters.keys()) == set(bullmq_sig.parameters.keys())


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
