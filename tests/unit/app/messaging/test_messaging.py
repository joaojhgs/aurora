"""Unit tests for the messaging infrastructure."""

import asyncio

import pytest
import pytest_asyncio
from pydantic import BaseModel

from app.messaging.bus import Envelope, Event
from app.messaging.bus_runtime import get_bus, set_bus
from app.messaging.local_bus import LocalBus


class MessageEvent(Event):
    """Test event message."""

    message: str
    value: int = 0


@pytest_asyncio.fixture
async def local_bus():
    """Fixture providing a LocalBus instance with topic validation disabled for testing."""
    bus = LocalBus(validate_topics=False)
    await bus.start()
    yield bus
    await bus.stop()


@pytest.mark.asyncio
async def test_bus_runtime_singleton(local_bus):
    """Test bus runtime singleton pattern."""
    # Set the bus
    set_bus(local_bus)

    # Get the bus
    bus = get_bus()
    assert bus is local_bus

    # Should raise error if not initialized
    set_bus(None)
    with pytest.raises(RuntimeError, match="MessageBus not initialized"):
        get_bus()


@pytest.mark.asyncio
async def test_local_bus_publish_subscribe(local_bus):
    """Test basic publish/subscribe functionality."""
    received_messages = []

    async def handler(env: Envelope):
        received_messages.append(env.payload)

    # Subscribe to topic
    local_bus.subscribe("test.topic", handler)

    # Publish message
    test_event = MessageEvent(message="Hello", value=42)
    await local_bus.publish("test.topic", test_event)

    # Wait for processing
    await asyncio.sleep(0.1)

    # Check message was received
    assert len(received_messages) == 1
    assert isinstance(received_messages[0], MessageEvent)
    assert received_messages[0].message == "Hello"
    assert received_messages[0].value == 42


@pytest.mark.asyncio
async def test_local_bus_priority_ordering(local_bus):
    """Test that commands respect priority ordering."""
    received_order = []

    async def handler(env: Envelope):
        received_order.append(env.priority)

    # Subscribe to command topic
    local_bus.subscribe("test.command", handler)

    # Publish commands with different priorities
    for priority in [80, 10, 50, 5, 90]:
        await local_bus.publish(
            "test.command",
            MessageEvent(message=f"Priority {priority}"),
            event=False,  # Command, not event
            priority=priority,
        )

    # Wait for processing
    await asyncio.sleep(0.2)

    # Check messages were processed in priority order (lower number = higher priority)
    assert len(received_order) == 5
    assert received_order == [5, 10, 50, 80, 90]


@pytest.mark.asyncio
async def test_local_bus_wildcard_subscription(local_bus):
    """Test wildcard topic subscription."""
    received_messages = []

    async def handler(env: Envelope):
        received_messages.append(env.type)

    # Subscribe with wildcard
    local_bus.subscribe("test.*", handler)

    # Publish to different topics
    await local_bus.publish("test.topic1", MessageEvent(message="1"))
    await local_bus.publish("test.topic2", MessageEvent(message="2"))
    await local_bus.publish("other.topic", MessageEvent(message="3"))

    # Wait for processing
    await asyncio.sleep(0.1)

    # Should only receive messages matching wildcard
    assert len(received_messages) == 2
    assert "test.topic1" in received_messages
    assert "test.topic2" in received_messages


@pytest.mark.asyncio
async def test_local_bus_command_retry(local_bus):
    """Test command retry logic on failure."""
    attempt_count = 0

    async def failing_handler(env: Envelope):
        nonlocal attempt_count
        attempt_count += 1
        if attempt_count < 3:
            raise ValueError("Simulated failure")

    # Subscribe to command topic
    local_bus.subscribe("test.retry", failing_handler)

    # Publish command with retries
    await local_bus.publish(
        "test.retry",
        MessageEvent(message="Retry me"),
        event=False,  # Command
        max_attempts=3,
    )

    # Wait for retries (with exponential backoff: 0.25s, 0.5s, 1.0s)
    await asyncio.sleep(2.0)

    # Handler should be called 3 times (initial + 2 retries)
    assert attempt_count == 3


@pytest.mark.asyncio
async def test_local_bus_stats(local_bus):
    """Test bus statistics tracking."""
    # Publish some messages
    await local_bus.publish("test.topic", MessageEvent(message="1"))
    await local_bus.publish("test.topic", MessageEvent(message="2"))

    # Get stats
    stats = local_bus.get_stats()

    # Check stats are tracked
    assert "published" in stats
    assert stats["published"] >= 2


@pytest.mark.asyncio
async def test_envelope_creation():
    """Test envelope creation and attributes."""
    message = MessageEvent(message="Test", value=123)

    env = Envelope(
        type="test.topic",
        payload=message,
        priority=10,
        origin="internal",
        max_attempts=3,
    )

    # Check envelope attributes
    assert env.type == "test.topic"
    assert env.payload == message
    assert env.priority == 10
    assert env.origin == "internal"
    assert env.max_attempts == 3
    assert env.attempts == 0
    assert env.id is not None


@pytest.mark.asyncio
async def test_local_bus_request_response(local_bus):
    """Test request/response pattern."""

    class TestQuery(BaseModel):
        question: str

    class TestResponse(BaseModel):
        ok: bool
        data: str

    async def query_handler(env: Envelope):
        # Simulate processing
        query = TestQuery.model_validate(env.payload)
        response = TestResponse(ok=True, data=f"Answer to: {query.question}")

        # Send response to reply topic
        if env.reply_to:
            await local_bus.publish(env.reply_to, response, origin="internal")

    # Subscribe to query topic
    local_bus.subscribe("test.query", query_handler)

    # Send request
    result = await local_bus.request(
        "test.query",
        TestQuery(question="What is 2+2?"),
        timeout=1.0,
    )

    # Check response
    assert result.ok is True
    assert "Answer to:" in result.data
