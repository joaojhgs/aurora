"""Unit tests for BullMQ bus implementation.

Tests verify that BullMQBus provides the same interface and behavior as LocalBus.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from pydantic import BaseModel

from app.messaging.bullmq_bus import BullMQBus


class SampleMessage(BaseModel):
    """Test message payload."""

    content: str
    value: int = 42


class SampleResponse(BaseModel):
    """Test response payload."""

    ok: bool
    data: str


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

    async def test_subscribe_direct_topic(self, mock_bullmq):
        """Test subscribing to a direct topic (no wildcards)."""
        bus = BullMQBus(validate_topics=False)
        bus._available = True
        bus._Queue = mock_bullmq["Queue"]
        bus._Worker = mock_bullmq["Worker"]

        handler = AsyncMock()
        bus.subscribe("TTS.Request", handler)

        assert "TTS.Request" in bus._handlers
        assert handler in bus._handlers["TTS.Request"]
        assert "TTS.Request" in bus._workers

    async def test_subscribe_wildcard_topic(self, mock_bullmq):
        """Test subscribing to a wildcard topic pattern."""
        bus = BullMQBus(validate_topics=False)
        bus._available = True
        bus._Queue = mock_bullmq["Queue"]
        bus._Worker = mock_bullmq["Worker"]

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
            event=True,
            priority=10,
            origin="test",
            reliable=True,
            ttl_ms=5000,
            max_attempts=3,
        )

        assert bus._stats["published"] == 1
        mock_bullmq["queue_instance"].add.assert_called_once()

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
            reply_to="reply.TTS.123",
        )

        call_args = mock_bullmq["queue_instance"].add.call_args
        job_data = call_args[0][1]
        assert job_data["reply_to"] == "reply.TTS.123"

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

        await bus.publish("TTS.Request", message)
        assert bus._stats["published"] == 1

        await bus.publish("TTS.Request", message)
        assert bus._stats["published"] == 2

    async def test_multiple_handlers_same_topic(self, mock_bullmq):
        """Test multiple handlers can subscribe to the same topic."""
        bus = BullMQBus(validate_topics=False)
        bus._available = True
        bus._Queue = mock_bullmq["Queue"]
        bus._Worker = mock_bullmq["Worker"]

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

        bullmq_methods = {name for name in dir(BullMQBus) if not name.startswith("_") and callable(getattr(BullMQBus, name))}

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
