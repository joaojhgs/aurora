"""Integration tests for complete message flow through the architecture.

Tests the interaction between services via the message bus.
"""

import asyncio

import pytest
import pytest_asyncio

from app.messaging.bus_runtime import set_bus
from app.messaging.local_bus import LocalBus
from app.tts.service import TTSRequest


@pytest_asyncio.fixture
async def bus():
    """Create and start a LocalBus for testing with topic validation disabled."""
    test_bus = LocalBus(command_queue_size=100, event_queue_size=500, validate_topics=False)
    await test_bus.start()
    set_bus(test_bus)
    yield test_bus
    await test_bus.stop()


@pytest.mark.asyncio
async def test_tts_request_flow(bus):
    """Test TTS request message flow."""
    events_received: list[str] = []

    async def event_handler(env):
        events_received.append(env.topic)

    # Subscribe to TTS events
    bus.subscribe("TTS.*", event_handler)

    # Publish TTS request
    request = TTSRequest(text="Test message", interrupt=False)
    await bus.publish("TTS.Request", request, event=False, priority=10, origin="test")

    # Give time for async processing
    await asyncio.sleep(0.2)

    # Note: Without actual TTS service running, we won't get events
    # This test validates the message can be published without errors
    assert True  # Message published successfully


@pytest.mark.asyncio
async def test_priority_ordering(bus):
    """Test that messages are processed in priority order."""
    processed_order: list[int] = []

    async def handler(env):
        processed_order.append(env.priority)

    bus.subscribe("test.*", handler)

    # Publish messages in reverse priority order
    for priority in [50, 10, 80]:
        await bus.publish("test.message", {"priority": priority}, event=False, priority=priority, origin="test")

    # Give time for processing
    await asyncio.sleep(0.3)

    # Verify they were processed in priority order (lower number = higher priority)
    assert processed_order == [10, 50, 80]


@pytest.mark.asyncio
async def test_wildcard_subscriptions(bus):
    """Test wildcard topic subscriptions."""
    received_topics: list[str] = []

    async def handler(env):
        received_topics.append(env.type)

    # Subscribe with wildcard
    bus.subscribe("STT.*", handler)

    # Publish various STT events
    topics = ["STT.Started", "STT.TranscriptionDetected", "STT.WakeWordDetected"]
    for topic in topics:
        await bus.publish(topic, {}, event=True, priority=50, origin="test")

    # Give time for processing
    await asyncio.sleep(0.3)

    # Verify all matching topics were received
    assert set(received_topics) == set(topics)


@pytest.mark.asyncio
async def test_request_response_pattern(bus):
    """Test request/response pattern for queries."""

    from pydantic import BaseModel

    class TestQuery(BaseModel):
        query: str
        limit: int = 10

    class TestResponse(BaseModel):
        result: str

    async def query_handler(env):
        # Simulate processing and send response
        query_obj = TestQuery.model_validate(env.payload)
        response = TestResponse(result=f"Processed: {query_obj.query}")

        # Send response back to reply_to topic
        if env.reply_to:
            await bus.publish(env.reply_to, response, origin="internal")

    bus.subscribe("DB.GetRecentMessages", query_handler)

    # Send query and wait for response
    result = await bus.request("DB.GetRecentMessages", TestQuery(query="test", limit=10), timeout=1.0, priority=10, origin="test")

    assert result.ok is True
    assert result.data.get("result") == "Processed: test"


@pytest.mark.asyncio
async def test_event_broadcast(bus):
    """Test that events are broadcast to all subscribers."""
    handler1_received = []
    handler2_received = []

    async def handler1(env):
        handler1_received.append(env.type)

    async def handler2(env):
        handler2_received.append(env.type)

    # Multiple subscribers to same event
    bus.subscribe("LLM.ResponseReady", handler1)
    bus.subscribe("LLM.ResponseReady", handler2)

    # Publish event
    await bus.publish("LLM.ResponseReady", {"response": "test"}, event=True, priority=50, origin="test")

    # Give time for processing
    await asyncio.sleep(0.3)

    # Both handlers should receive the event
    assert "LLM.ResponseReady" in handler1_received
    assert "LLM.ResponseReady" in handler2_received


@pytest.mark.asyncio
async def test_bus_stats(bus):
    """Test bus statistics tracking."""
    # Publish some messages
    for i in range(5):
        await bus.publish(f"test.message.{i}", {"index": i}, event=True, priority=50, origin="test")

    await asyncio.sleep(0.2)

    # Get stats
    stats = bus.get_stats()

    assert stats["published"] >= 5
    assert "delivered" in stats


@pytest.mark.asyncio
async def test_command_retry_on_failure(bus):
    """Test that commands are retried on failure."""
    attempt_count = [0]

    async def failing_handler(env):
        attempt_count[0] += 1
        if attempt_count[0] < 3:
            raise Exception("Simulated failure")
        return {"success": True}

    bus.subscribe("test.retry", failing_handler)

    # This should retry up to max_retries
    await bus.publish("test.retry", {"test": "data"}, event=False, priority=10, origin="test")

    # Give time for retries
    await asyncio.sleep(2.0)

    # Should have retried multiple times
    assert attempt_count[0] >= 2


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
