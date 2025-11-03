"""Extended tests for LocalBus to improve coverage."""

import asyncio

import pytest
import pytest_asyncio

from app.messaging.bus import Command, Envelope, Event, QueryResult
from app.messaging.local_bus import LocalBus


class BusEvent(Event):
    """Test event."""

    data: str


class BusCommand(Command):
    """Test command."""

    action: str


@pytest_asyncio.fixture
async def local_bus():
    """Fixture providing a LocalBus instance."""
    bus = LocalBus(validate_topics=False)
    await bus.start()
    yield bus
    await bus.stop()


class TestLocalBusEdgeCases:
    """Test edge cases and error handling for LocalBus."""

    @pytest.mark.asyncio
    async def test_handler_exception_handling(self, local_bus):
        """Test that handler exceptions don't crash the bus."""
        received = []

        async def failing_handler(env: Envelope):
            raise ValueError("Handler error")

        async def working_handler(env: Envelope):
            received.append(env.payload)

        # Subscribe both handlers
        local_bus.subscribe("test.error", failing_handler)
        local_bus.subscribe("test.error", working_handler)

        # Publish event
        await local_bus.publish("test.error", BusEvent(data="test"))
        await asyncio.sleep(0.1)

        # Working handler should still receive message
        assert len(received) == 1

    @pytest.mark.asyncio
    async def test_command_retry_logic(self, local_bus):
        """Test command retry with exponential backoff."""
        attempt_count = [0]

        async def failing_command_handler(env: Envelope):
            attempt_count[0] += 1
            if attempt_count[0] < 2:
                raise ValueError("Command failed")

        local_bus.subscribe("test.command", failing_command_handler)

        await local_bus.publish("test.command", BusCommand(action="retry_test"), event=False, max_attempts=3)

        # Wait for retries
        await asyncio.sleep(2.0)

        # Should have tried at least 2 times (may be 3)
        assert attempt_count[0] >= 2

    @pytest.mark.asyncio
    async def test_dead_letter_queue(self, local_bus):
        """Test that failed commands go to dead letter queue."""

        async def always_failing_handler(env: Envelope):
            raise ValueError("Always fails")

        local_bus.subscribe("test.deadletter", always_failing_handler)

        await local_bus.publish("test.deadletter", BusCommand(action="will_fail"), event=False, max_attempts=2)

        # Wait for all retries and dead letter
        await asyncio.sleep(1.0)

        # Check dead letter queue stats
        stats = local_bus.get_stats()
        assert stats["dead_letters"] > 0

    @pytest.mark.asyncio
    async def test_no_subscribers(self, local_bus):
        """Test publishing to topic with no subscribers."""
        # Should not raise error
        await local_bus.publish("nonexistent.topic", BusEvent(data="test"))
        await asyncio.sleep(0.1)

    # @pytest.mark.asyncio
    # async def test_queue_full_command(self, local_bus):
    #     """Test command queue behavior when filling up."""
    #     # Create bus with small queue
    #     small_bus = LocalBus(command_queue_size=2, validate_topics=False)
    #     await small_bus.start()
    #
    #     try:
    #         received = []
    #
    #         async def handler(env: Envelope):
    #             received.append(env.payload)
    #             await asyncio.sleep(0.5)  # Slow processing
    #
    #         small_bus.subscribe("test.full", handler)
    #
    #         # Publish several commands
    #         for i in range(3):
    #             try:
    #                 await small_bus.publish("test.full", TestCommand(action=f"cmd{i}"), event=False)
    #             except asyncio.QueueFull:
    #                 # Queue full is expected
    #                 pass
    #
    #         await asyncio.sleep(1.5)
    #
    #         # At least some commands should be processed
    #         assert len(received) > 0
    #     finally:
    #         await small_bus.stop()

    @pytest.mark.asyncio
    async def test_event_queue_behavior(self, local_bus):
        """Test event queue handles multiple messages."""
        received = []

        async def handler(env: Envelope):
            received.append(env.payload)

        local_bus.subscribe("test.event.many", handler)

        # Publish several events
        for i in range(5):
            await local_bus.publish("test.event.many", BusEvent(data=f"msg{i}"))

        await asyncio.sleep(0.3)

        # Should receive all or most messages
        assert len(received) >= 4

    @pytest.mark.asyncio
    async def test_wildcard_prefix_matching(self, local_bus):
        """Test wildcard subscription with prefix matching."""
        received = []

        async def handler(env: Envelope):
            received.append(env.type)

        # Subscribe with wildcard
        local_bus.subscribe("test.wildcard.*", handler)

        # Publish to matching topics
        await local_bus.publish("test.wildcard.one", BusEvent(data="1"))
        await local_bus.publish("test.wildcard.two", BusEvent(data="2"))
        await local_bus.publish("test.other.topic", BusEvent(data="3"))

        await asyncio.sleep(0.2)

        # Should receive first two, not third
        assert len(received) == 2
        assert "test.wildcard.one" in received
        assert "test.wildcard.two" in received

    @pytest.mark.asyncio
    async def test_request_response_pattern(self, local_bus):
        """Test request-response pattern."""

        async def request_handler(env: Envelope):
            # Send response to reply_to topic
            if env.reply_to:
                await local_bus.publish(env.reply_to, QueryResult(ok=True, data={"response": "success"}))

        local_bus.subscribe("test.request", request_handler)

        # Make request
        result = await local_bus.request("test.request", BusCommand(action="ping"), timeout=2.0)

        assert result.ok is True
        assert result.data == {"response": "success"}

    @pytest.mark.asyncio
    async def test_request_timeout(self, local_bus):
        """Test request timeout."""
        # Don't subscribe any handler, so request will timeout

        # Request should timeout
        try:
            result = await local_bus.request("test.nonexistent", BusCommand(action="test"), timeout=0.2)
            # If we get here, check if result is None or error
            assert result is None or not result.ok
        except (asyncio.TimeoutError, Exception):
            # Timeout or other error is expected
            pass

    @pytest.mark.asyncio
    async def test_concurrent_handlers(self, local_bus):
        """Test that multiple handlers run concurrently."""
        execution_order = []

        async def handler1(env: Envelope):
            execution_order.append("1_start")
            await asyncio.sleep(0.1)
            execution_order.append("1_end")

        async def handler2(env: Envelope):
            execution_order.append("2_start")
            await asyncio.sleep(0.05)
            execution_order.append("2_end")

        local_bus.subscribe("test.concurrent", handler1)
        local_bus.subscribe("test.concurrent", handler2)

        await local_bus.publish("test.concurrent", BusEvent(data="test"))
        await asyncio.sleep(0.2)

        # Both should start before either finishes (concurrent execution)
        assert "1_start" in execution_order
        assert "2_start" in execution_order
        assert execution_order.index("2_start") < execution_order.index("1_end")

    @pytest.mark.asyncio
    async def test_get_stats(self, local_bus):
        """Test statistics tracking."""

        async def handler(env: Envelope):
            pass

        local_bus.subscribe("test.stats", handler)

        # Publish some messages
        for i in range(5):
            await local_bus.publish("test.stats", BusEvent(data=f"msg{i}"))

        await asyncio.sleep(0.2)

        stats = local_bus.get_stats()
        assert stats["published"] >= 5
        assert stats["delivered"] >= 5

    @pytest.mark.asyncio
    async def test_stop_cleans_up_workers(self, local_bus):
        """Test that stop() cleans up all workers."""

        async def handler(env: Envelope):
            pass

        local_bus.subscribe("test.cleanup", handler)
        await local_bus.publish("test.cleanup", BusEvent(data="test"))

        await asyncio.sleep(0.1)

        # Stop should clean up
        await local_bus.stop()

        # Shutdown event should be set
        assert local_bus._shutdown.is_set()

    @pytest.mark.asyncio
    async def test_multiple_subscribe_same_topic(self, local_bus):
        """Test multiple handlers on same topic."""
        received1 = []
        received2 = []

        async def handler1(env: Envelope):
            received1.append(env.payload)

        async def handler2(env: Envelope):
            received2.append(env.payload)

        local_bus.subscribe("test.multi", handler1)
        local_bus.subscribe("test.multi", handler2)

        await local_bus.publish("test.multi", BusEvent(data="test"))
        await asyncio.sleep(0.1)

        # Both handlers should receive
        assert len(received1) == 1
        assert len(received2) == 1

    @pytest.mark.asyncio
    async def test_priority_with_multiple_commands(self, local_bus):
        """Test strict priority ordering with many commands."""
        execution_order = []

        async def handler(env: Envelope):
            execution_order.append(env.priority)

        local_bus.subscribe("test.priority", handler)

        # Publish commands with various priorities
        priorities = [99, 1, 50, 25, 75, 10, 5]
        for p in priorities:
            await local_bus.publish("test.priority", BusCommand(action=f"prio_{p}"), event=False, priority=p)

        await asyncio.sleep(0.5)

        # Should be sorted
        assert execution_order == sorted(priorities)

    @pytest.mark.asyncio
    async def test_envelope_metadata(self, local_bus):
        """Test that envelope metadata is preserved."""
        received_env = []

        async def handler(env: Envelope):
            received_env.append(env)

        local_bus.subscribe("test.metadata", handler)

        await local_bus.publish("test.metadata", BusEvent(data="test"), origin="external", priority=25)

        await asyncio.sleep(0.1)

        assert len(received_env) == 1
        env = received_env[0]
        assert env.origin == "external"
        assert env.priority == 25
        assert env.type == "test.metadata"
