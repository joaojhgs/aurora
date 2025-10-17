"""BullMQ-based MessageBus implementation for process/microservices mode.

This implementation uses Redis and BullMQ for distributed message processing:
- Redis-backed queues with persistence
- Job priorities, attempts, and exponential backoff
- Multiple workers for horizontal scaling
- Built-in retry and dead-letter handling
- Topic validation with event registry
- Request/response pattern with reply queues
"""

from __future__ import annotations

import asyncio
import logging
import uuid as uuid_lib
from collections import defaultdict
from typing import Dict, List

from pydantic import BaseModel

from .bus import Envelope, Handler, QueryResult
from .event_registry import get_event_registry

logger = logging.getLogger(__name__)


class BullMQBus:
    """Redis-backed message bus using BullMQ for process/microservices mode.

    Features:
    - Persistent message queues in Redis
    - Job priorities and automatic retry
    - Exponential backoff for failed jobs
    - Horizontal scaling with multiple workers
    - Dead-letter queue for failed jobs
    - Topic validation with event registry
    - Request/response pattern
    - Statistics tracking

    Requires:
    - Redis server running
    - bullmq Python package installed

    Note: BullMQ is queue-based, so wildcard subscriptions are emulated
    by subscribing to base queue and filtering messages.
    """

    def __init__(
        self,
        redis_url: str = "redis://localhost:6379",
        validate_topics: bool = True,
    ):
        """Initialize the BullMQ bus.

        Args:
            redis_url: Redis connection URL
            validate_topics: Whether to validate topics against registry (default: True)
        """
        self.redis_url = redis_url
        self._queues: dict[str, Queue] = {}
        self._workers: dict[str, Worker] = {}
        self._handlers: dict[str, list[Handler]] = defaultdict(list)
        self._wildcard_patterns: dict[str, list[Handler]] = defaultdict(list)
        self._started = False
        self._validate_topics = validate_topics

        # Response futures for request/response pattern
        self._response_futures: dict[str, asyncio.Future] = {}

        # Statistics tracking
        self._stats = {
            "published": 0,
            "delivered": 0,
            "retries": 0,
            "dead_letters": 0,
        }

        # Check if bullmq is available
        try:
            from bullmq import Queue, QueueEvents, Worker  # type: ignore

            self._Queue = Queue
            self._Worker = Worker
            self._QueueEvents = QueueEvents
            self._available = True
        except ImportError:
            logger.warning("bullmq package not available. Install with: pip install bullmq")
            self._available = False

    async def start(self) -> None:
        """Start the message bus."""
        if not self._available:
            raise RuntimeError("BullMQ not available. Install with: pip install bullmq")

        self._started = True
        logger.info(f"BullMQBus started with Redis at {self.redis_url}")

    async def stop(self) -> None:
        """Stop the message bus and cleanup resources."""
        logger.info("Stopping BullMQBus...")

        # Close all workers
        for topic, worker in list(self._workers.items()):
            try:
                await worker.close()
                logger.debug(f"Closed worker for topic: {topic}")
            except Exception as e:
                logger.error(f"Error closing worker for {topic}: {e}")

        # Close all queues
        for topic, queue in list(self._queues.items()):
            try:
                await queue.close()
                logger.debug(f"Closed queue for topic: {topic}")
            except Exception as e:
                logger.error(f"Error closing queue for {topic}: {e}")

        self._started = False
        logger.info("BullMQBus stopped")

    def subscribe(self, topic: str, handler: Handler) -> None:
        """Subscribe to a topic with a handler.

        Creates a BullMQ worker to process jobs for the topic.

        Args:
            topic: Topic name (supports wildcards like "TTS.*")
            handler: Async function to handle messages

        Raises:
            ValueError: If topic validation is enabled and topic is invalid
        """
        if not self._available:
            raise RuntimeError("BullMQ not available")

        # Validate topic if enabled
        if self._validate_topics:
            try:
                registry = get_event_registry()
                registry.validate_subscribe(topic)
            except ValueError as e:
                logger.error(f"Topic validation failed for subscription: {e}")
                raise

        # Check if topic has wildcard
        if "*" in topic:
            # Store wildcard handler for filtering
            self._wildcard_patterns[topic].append(handler)
            # Extract base queue name (e.g., "TTS.*" -> "TTS")
            base_queue = topic.split("*")[0].rstrip(".")
            if not base_queue:
                base_queue = "_all_topics_"

            # Create worker for base queue if not exists
            if base_queue not in self._workers:
                self._create_worker(base_queue)

            logger.debug(f"Subscribed wildcard handler to pattern: {topic}")
        else:
            # Direct topic subscription
            self._handlers[topic].append(handler)

            # Create worker for this topic if not exists
            if topic not in self._workers:
                self._create_worker(topic)

            logger.debug(f"Subscribed handler to topic: {topic}")

    def _create_worker(self, queue_name: str) -> None:
        """Create a BullMQ worker for a queue.

        Args:
            queue_name: Queue name to create worker for
        """

        async def _processor(job, token):
            """Process a job from the queue."""
            try:
                # Reconstruct envelope from job data
                job_data = job.data
                actual_topic = job_data.get("type", queue_name)

                env = Envelope(
                    id=job_data.get("id"),
                    type=actual_topic,
                    payload=BaseModel.parse_obj(job_data.get("payload", {})),
                    origin=job_data.get("origin", "system"),
                    priority=job.opts.get("priority", 50),
                    attempts=job.attemptsMade,
                    max_attempts=job.opts.get("attempts", 3),
                    reply_to=job_data.get("reply_to"),
                    correlation_id=job_data.get("correlation_id"),
                )

                # Find matching handlers (direct + wildcard)
                matching_handlers = []

                # Direct handlers
                matching_handlers.extend(self._handlers.get(actual_topic, []))

                # Wildcard handlers
                for pattern, handlers in self._wildcard_patterns.items():
                    if self._topic_matches(actual_topic, pattern):
                        matching_handlers.extend(handlers)

                if not matching_handlers:
                    logger.debug(f"No handlers for topic: {actual_topic}")
                    return

                # Execute all handlers concurrently
                await asyncio.gather(*[self._call_handler(h, env) for h in matching_handlers])

                self._stats["delivered"] += 1
                logger.debug(f"Processed job {job.id} for topic {actual_topic}")

                # Handle reply_to for request/response
                if env.reply_to:
                    # Check if this is a response to a pending request
                    if env.correlation_id in self._response_futures:
                        fut = self._response_futures.pop(env.correlation_id)
                        if not fut.done():
                            if hasattr(env.payload, "model_dump"):
                                result_data = env.payload.model_dump()
                            else:
                                result_data = env.payload

                            if isinstance(result_data, dict) and "ok" in result_data:
                                fut.set_result(QueryResult(**result_data))
                            else:
                                fut.set_result(QueryResult(ok=True, data=result_data))

            except Exception as e:
                logger.error(
                    f"Error processing job {job.id} for queue {queue_name}: {e}",
                    exc_info=True,
                )
                self._stats["retries"] += 1
                raise  # Re-raise to trigger retry

        # Create worker with event listener for dead-letter tracking
        worker = self._Worker(
            queue_name,
            _processor,
            {
                "connection": self.redis_url,
                "concurrency": 4,  # Process up to 4 jobs concurrently
            },
        )

        # Listen for failed jobs (dead-letter)
        worker.on("failed", lambda job, error: self._on_job_failed(job, error))

        self._workers[queue_name] = worker
        logger.info(f"Created BullMQ worker for queue: {queue_name}")

    async def _call_handler(self, handler: Handler, env: Envelope) -> None:
        """Call a handler with error handling.

        Args:
            handler: Handler function
            env: Message envelope
        """
        try:
            await handler(env)
        except Exception as e:
            logger.error(f"Error in handler for topic {env.type}: {e}", exc_info=True)
            raise

    def _on_job_failed(self, job, error) -> None:
        """Handle failed jobs (dead-letter).

        Args:
            job: Failed job
            error: Error that caused failure
        """
        self._stats["dead_letters"] += 1
        logger.error(f"Job {job.id} moved to dead-letter: {error}", exc_info=True if error else False)

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
            topic: Topic name (queue name in BullMQ)
            message: Message payload
            event: True for broadcast, False for point-to-point
            priority: Job priority (0=highest, 99=lowest)
            origin: Message origin
            reliable: Whether to guarantee delivery (with retries)
            ttl_ms: Job time-to-live in milliseconds
            max_attempts: Maximum retry attempts
            reply_to: Optional reply topic for request/response pattern

        Raises:
            ValueError: If topic validation is enabled and topic is invalid
        """
        if not self._available:
            raise RuntimeError("BullMQ not available")

        # Validate topic if enabled
        if self._validate_topics:
            try:
                registry = get_event_registry()
                registry.validate_publish(topic)
            except ValueError as e:
                logger.error(f"Topic validation failed for publish: {e}")
                raise

        # Determine target queue (for wildcards, use base queue)
        queue_name = topic
        if "*" in topic:
            # Extract base queue name
            queue_name = topic.split("*")[0].rstrip(".")
            if not queue_name:
                queue_name = "_all_topics_"

        # Get or create queue for this topic
        if queue_name not in self._queues:
            self._queues[queue_name] = self._Queue(
                queue_name,
                {"connection": self.redis_url},
            )

        queue = self._queues[queue_name]

        # Generate unique ID
        job_id = str(uuid_lib.uuid4())

        # Prepare job data
        job_data = {
            "id": job_id,
            "type": topic,  # Store actual topic
            "payload": message.model_dump() if hasattr(message, "model_dump") else message,
            "origin": origin,
            "reply_to": reply_to,
        }

        # Job options
        job_opts = {
            "priority": priority,
            "attempts": max_attempts if reliable else 1,
            "backoff": {
                "type": "exponential",
                "delay": 250,  # Start with 250ms, doubles each retry
            },
            "removeOnComplete": True,  # Clean up completed jobs
            "removeOnFail": False,  # Keep failed jobs for debugging
        }

        if ttl_ms:
            job_opts["ttl"] = ttl_ms

        # Add job to queue
        await queue.add(queue_name, job_data, job_opts)
        self._stats["published"] += 1

        logger.debug(f"Published message to BullMQ queue {queue_name} (topic: {topic}) " f"with priority {priority}")

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

        Implements request/response pattern using:
        - Unique correlation IDs for matching requests/responses
        - Temporary reply queues for responses
        - Timeout handling for missing responses

        Args:
            topic: Topic name for the request
            message: Request payload
            priority: Message priority
            origin: Message origin
            timeout: Response timeout in seconds
            ttl_ms: Time-to-live in milliseconds
            max_attempts: Maximum retry attempts

        Returns:
            QueryResult containing the response
        """
        if not self._available:
            raise RuntimeError("BullMQ not available")

        # Generate unique correlation ID
        correlation_id = str(uuid_lib.uuid4())
        reply_topic = f"reply.{message.__class__.__name__}.{correlation_id}"

        # Create future for response
        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        self._response_futures[correlation_id] = fut

        # Subscribe to reply topic (one-time handler)
        async def _on_reply(env: Envelope) -> None:
            """Handle reply message."""
            if env.correlation_id == correlation_id:
                if not fut.done():
                    if hasattr(env.payload, "model_dump"):
                        result_data = env.payload.model_dump()
                    else:
                        result_data = env.payload

                    if isinstance(result_data, dict) and "ok" in result_data:
                        fut.set_result(QueryResult(**result_data))
                    else:
                        fut.set_result(QueryResult(ok=True, data=result_data))

        # Subscribe to reply topic
        self.subscribe(reply_topic, _on_reply)

        # Publish request with reply_to and correlation_id
        job_data = {
            "id": str(uuid_lib.uuid4()),
            "type": topic,
            "payload": message.model_dump() if hasattr(message, "model_dump") else message,
            "origin": origin,
            "reply_to": reply_topic,
            "correlation_id": correlation_id,
        }

        # Determine target queue
        queue_name = topic
        if "*" in topic:
            queue_name = topic.split("*")[0].rstrip(".")
            if not queue_name:
                queue_name = "_all_topics_"

        # Get or create queue
        if queue_name not in self._queues:
            self._queues[queue_name] = self._Queue(
                queue_name,
                {"connection": self.redis_url},
            )

        queue = self._queues[queue_name]

        # Job options
        job_opts = {
            "priority": priority,
            "attempts": max_attempts,
            "backoff": {
                "type": "exponential",
                "delay": 250,
            },
            "removeOnComplete": True,
            "removeOnFail": False,
        }

        if ttl_ms:
            job_opts["ttl"] = ttl_ms

        # Publish request
        await queue.add(queue_name, job_data, job_opts)
        self._stats["published"] += 1

        logger.debug(f"Sent request to {topic} with correlation_id {correlation_id}")

        # Wait for response with timeout
        try:
            result = await asyncio.wait_for(fut, timeout)
            logger.debug(f"Received response for correlation_id {correlation_id}")
            return result
        except asyncio.TimeoutError:
            logger.error(f"Request to {topic} timed out after {timeout}s")
            # Clean up future
            self._response_futures.pop(correlation_id, None)
            return QueryResult(ok=False, error=f"Request timeout after {timeout}s")

    def get_stats(self) -> dict:
        """Get bus statistics.

        Returns:
            Dictionary containing bus metrics
        """
        return dict(self._stats)
