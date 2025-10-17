"""Local in-process MessageBus implementation using asyncio.

This implementation provides:
- Priority-based command queues (lower number = higher priority)
- Best-effort event broadcast
- Retry logic with exponential backoff for commands
- Dead-letter handling for failed commands
- No strict FIFO ordering (priority takes precedence)
"""

from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from typing import Dict, List

from pydantic import BaseModel

from .bus import Envelope, Handler, QueryResult
from .event_registry import get_event_registry

logger = logging.getLogger(__name__)


class LocalBus:
    """In-process asyncio-based message bus for thread mode.

    Features:
    - Separate priority queues for commands (point-to-point)
    - Best-effort queues for events (broadcast)
    - Automatic retry with exponential backoff
    - Dead-letter queue for failed messages
    - Topic pattern matching with wildcards
    """

    def __init__(
        self,
        *,
        command_queue_size: int = 1000,
        event_queue_size: int = 5000,
        validate_topics: bool = True,
    ):
        """Initialize the local bus.

        Args:
            command_queue_size: Maximum size for command queues
            event_queue_size: Maximum size for event queues
            validate_topics: Whether to validate topics against registry (default: True)
        """
        # Subscribers by topic
        self._subs: dict[str, list[Handler]] = defaultdict(list)

        # Command queues (priority-based)
        self._cmd_queues: dict[str, asyncio.PriorityQueue] = defaultdict(lambda: asyncio.PriorityQueue(maxsize=command_queue_size))

        # Event queues (FIFO)
        self._evt_queues: dict[str, asyncio.Queue] = defaultdict(lambda: asyncio.Queue(maxsize=event_queue_size))

        # Worker tracking
        self._cmd_workers_started: dict[str, bool] = defaultdict(bool)
        self._evt_workers_started: dict[str, bool] = defaultdict(bool)

        # Shutdown signal
        self._shutdown = asyncio.Event()

        # Dead-letter queue for failed commands
        self._dead_letter: asyncio.Queue = asyncio.Queue()

        # Topic validation
        self._validate_topics = validate_topics

        # Metrics
        self._stats = {
            "published": 0,
            "delivered": 0,
            "retries": 0,
            "dead_letters": 0,
        }

    async def start(self) -> None:
        """Start the message bus."""
        logger.info("LocalBus started")

    async def stop(self) -> None:
        """Stop the message bus and cleanup resources."""
        logger.info("Stopping LocalBus...")
        self._shutdown.set()
        await asyncio.sleep(0.1)  # Give workers time to finish
        logger.info("LocalBus stopped")

    def subscribe(self, topic: str, handler: Handler) -> None:
        """Subscribe to a topic with a handler.

        Args:
            topic: Topic name (supports wildcards like "TTS.*")
            handler: Async function to handle messages

        Raises:
            ValueError: If topic validation is enabled and topic is invalid
        """
        # Validate topic if enabled
        if self._validate_topics:
            try:
                registry = get_event_registry()
                registry.validate_subscribe(topic)
            except ValueError as e:
                logger.error(f"Topic validation failed for subscription: {e}")
                raise

        self._subs[topic].append(handler)
        logger.debug(f"Subscribed handler to topic: {topic}")

        # Start event worker for this topic if not already started
        if not self._evt_workers_started[topic]:
            self._evt_workers_started[topic] = True
            asyncio.create_task(self._event_worker(topic))

    async def _deliver(self, topic: str, env: Envelope, raise_errors: bool = False) -> None:
        """Deliver a message to all matching subscribers concurrently.

        Args:
            topic: Topic to deliver to
            env: Message envelope
            raise_errors: If True, re-raise handler exceptions (for command retry logic)
        """
        # Collect all matching handlers
        matching_handlers = []
        for pattern, handlers in list(self._subs.items()):
            # Simple wildcard matching
            if self._topic_matches(topic, pattern):
                matching_handlers.extend(handlers)

        if not matching_handlers:
            logger.debug(f"No subscribers for topic: {topic}")
            return

        # Run all handlers concurrently
        async def _run_handler(handler):
            try:
                await handler(env)
                self._stats["delivered"] += 1
            except Exception as e:
                logger.error(
                    f"Error in handler for topic {topic}: {e}",
                    exc_info=True,
                )
                if raise_errors:
                    raise
                return e
            return None

        # Execute all handlers concurrently
        results = await asyncio.gather(*[_run_handler(h) for h in matching_handlers], return_exceptions=not raise_errors)

        # Check for errors if raise_errors is True
        if raise_errors:
            for result in results:
                if isinstance(result, Exception):
                    raise result

    def _topic_matches(self, topic: str, pattern: str) -> bool:
        """Check if a topic matches a subscription pattern.

        Args:
            topic: Actual topic name
            pattern: Subscription pattern (may include wildcards)

        Returns:
            True if topic matches pattern
        """
        if pattern == topic:
            return True
        if pattern.endswith("*"):
            prefix = pattern[:-1]
            return topic.startswith(prefix)
        return False

    async def _event_worker(self, topic: str) -> None:
        """Worker for processing event messages.

        Args:
            topic: Topic to process events for
        """
        queue = self._evt_queues[topic]
        logger.debug(f"Event worker started for topic: {topic}")

        while not self._shutdown.is_set():
            try:
                env = await asyncio.wait_for(queue.get(), timeout=0.1)
                await self._deliver(topic, env)
                queue.task_done()
            except asyncio.TimeoutError:
                continue
            except Exception as e:
                logger.error(f"Error in event worker for {topic}: {e}")

    async def _command_worker(self, topic: str) -> None:
        """Worker for processing command messages with retry logic.

        Args:
            topic: Topic to process commands for
        """
        queue = self._cmd_queues[topic]
        logger.info(f"Command worker started for topic: {topic}")

        while not self._shutdown.is_set():
            try:
                # Get prioritized command
                prio, env = await asyncio.wait_for(queue.get(), timeout=0.1)

                try:
                    await self._deliver(topic, env, raise_errors=True)
                except Exception as e:
                    logger.error(f"Error delivering command to {topic} " f"(attempt {env.attempts + 1}/{env.max_attempts}): {e}")

                    # Retry with exponential backoff
                    env.attempts += 1
                    if env.attempts < env.max_attempts:
                        self._stats["retries"] += 1
                        # Calculate backoff delay
                        delay = min(0.25 * (2**env.attempts), 10.0)
                        await asyncio.sleep(delay)
                        # Re-queue with same priority
                        queue.task_done()  # Mark current task done before re-queueing
                        await queue.put((prio, env))
                        logger.info(f"Re-queued command {env.id} to {topic} " f"(attempt {env.attempts}/{env.max_attempts})")
                    else:
                        # Dead-letter
                        self._stats["dead_letters"] += 1
                        await self._dead_letter.put(env)
                        logger.error(f"Command {env.id} to {topic} exceeded max attempts, " f"moved to dead-letter queue")
                        queue.task_done()
                else:
                    # Success case
                    queue.task_done()

            except asyncio.TimeoutError:
                continue
            except Exception as e:
                logger.error(f"Error in command worker for {topic}: {e}")

    async def publish(
        self,
        topic: str,
        message: BaseModel,
        *,
        event: bool = True,
        priority: int = 50,
        origin: str = "internal",
        reliable: bool = True,
        ttl_ms: int | None = None,
        max_attempts: int = 3,
        reply_to: str | None = None,
    ) -> None:
        """Publish a message to a topic.

        Args:
            topic: Topic name
            message: Message payload
            event: True for broadcast events, False for point-to-point commands
            priority: Message priority (0=highest, 99=lowest)
            origin: Message origin
            reliable: Whether to guarantee delivery (with retries)
            ttl_ms: Time-to-live in milliseconds (not implemented yet)
            max_attempts: Maximum retry attempts
            reply_to: Optional reply topic for request/response pattern

        Raises:
            ValueError: If topic validation is enabled and topic is invalid
        """
        # Validate topic if enabled
        if self._validate_topics:
            try:
                registry = get_event_registry()
                registry.validate_publish(topic)
            except ValueError as e:
                logger.error(f"Topic validation failed for publish: {e}")
                raise

        env = Envelope(
            type=topic,
            payload=message,
            origin=origin,
            priority=priority,
            max_attempts=max_attempts if reliable else 1,
            reply_to=reply_to,
        )

        self._stats["published"] += 1

        if event:
            # Event: broadcast to all subscribers
            if not self._evt_workers_started[topic]:
                self._evt_workers_started[topic] = True
                asyncio.create_task(self._event_worker(topic))

            try:
                await self._evt_queues[topic].put(env)
                logger.debug(f"Published event to {topic}")
            except asyncio.QueueFull:
                logger.warning(f"Event queue full for {topic}, dropping message")
        else:
            # Command: point-to-point with priority
            if not self._cmd_workers_started[topic]:
                self._cmd_workers_started[topic] = True
                asyncio.create_task(self._command_worker(topic))

            try:
                await self._cmd_queues[topic].put((priority, env))
                logger.debug(f"Published command to {topic} with priority {priority}")
            except asyncio.QueueFull:
                logger.error(f"Command queue full for {topic}, cannot publish")
                raise

    async def request(
        self,
        topic: str,
        message: BaseModel,
        *,
        priority: int = 50,
        origin: str = "internal",
        timeout: float = 5.0,
        ttl_ms: int | None = None,
        max_attempts: int = 3,
    ) -> QueryResult:
        """Send a request and wait for a response.

        Args:
            topic: Topic name for the request
            message: Request payload
            priority: Message priority
            origin: Message origin
            timeout: Response timeout in seconds
            ttl_ms: Time-to-live in milliseconds (not implemented yet)
            max_attempts: Maximum retry attempts

        Returns:
            QueryResult containing the response
        """
        import uuid as uuid_lib

        # Create a future for the response
        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        reply_topic = f"reply.{message.__class__.__name__}.{uuid_lib.uuid4()}"

        # Subscribe to reply topic
        async def _on_reply(env: Envelope) -> None:
            if not fut.done():
                if hasattr(env.payload, "model_dump"):
                    result_data = env.payload.model_dump()
                else:
                    result_data = env.payload

                if isinstance(result_data, dict) and "ok" in result_data:
                    fut.set_result(QueryResult(**result_data))
                else:
                    fut.set_result(QueryResult(ok=True, data=result_data))

        self.subscribe(reply_topic, _on_reply)

        # Publish request with reply_to field
        await self.publish(
            topic,
            message,
            event=False,
            priority=priority,
            origin=origin,
            max_attempts=max_attempts,
            reply_to=reply_topic,
        )

        # Wait for response
        try:
            result = await asyncio.wait_for(fut, timeout)
            return result
        except asyncio.TimeoutError:
            logger.error(f"Request to {topic} timed out after {timeout}s")
            return QueryResult(ok=False, error=f"Request timeout after {timeout}s")

    def get_stats(self) -> dict:
        """Get bus statistics.

        Returns:
            Dictionary containing bus metrics
        """
        return dict(self._stats)
