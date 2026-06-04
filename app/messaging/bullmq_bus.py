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
import uuid as uuid_lib
from collections import defaultdict

from pydantic import BaseModel

from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.shared.contracts.registry import all_contracts

from .bus import Envelope, Handler, QueryResult


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
            # Some versions of python-bullmq expose only Queue and Worker
            # QueueEvents may not be available. Import only what we use.
            from bullmq import Queue, Worker  # type: ignore

            self._Queue = Queue
            self._Worker = Worker
            self._available = True
        except ImportError:
            log_warning("bullmq package not available. Install with: pip install bullmq")
            self._available = False

    async def start(self) -> None:
        """Start the message bus."""
        if not self._available:
            raise RuntimeError("BullMQ not available. Install with: pip install bullmq")

        self._started = True
        log_info(f"BullMQBus started with Redis at {self.redis_url}")

    async def stop(self) -> None:
        """Stop the message bus and cleanup resources."""
        log_info("Stopping BullMQBus...")

        # Close all workers
        for topic, worker in list(self._workers.items()):
            try:
                await worker.close()
                log_debug(f"Closed worker for topic: {topic}")
            except Exception as e:
                log_error(f"Error closing worker for {topic}: {e}")

        # Close all queues
        for topic, queue in list(self._queues.items()):
            try:
                await queue.close()
                log_debug(f"Closed queue for topic: {topic}")
            except Exception as e:
                log_error(f"Error closing queue for {topic}: {e}")

        self._started = False
        log_info("BullMQBus stopped")

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

        # Note: Subscriptions are always allowed for events.
        # Events don't need to be registered as contracts - they're published and subscribed to.
        # Only callable methods (queries/commands) need @method_contract decorators.
        # We don't validate subscriptions because services may subscribe to events
        # that are published by other services without contracts.

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

            log_debug(f"Subscribed wildcard handler to pattern: {topic}")
        else:
            # Direct topic subscription
            self._handlers[topic].append(handler)

            # Create worker for this topic if not exists
            if topic not in self._workers:
                self._create_worker(topic)

            log_debug(f"Subscribed handler to topic: {topic}")

    def unsubscribe(self, topic: str, handler: Handler) -> None:
        """Remove a handler previously registered with ``subscribe``."""
        if "*" in topic:
            handlers = self._wildcard_patterns.get(topic)
            if handlers:
                try:
                    handlers.remove(handler)
                    log_debug(f"Unsubscribed wildcard handler from pattern: {topic}")
                except ValueError:
                    pass
            return
        handlers = self._handlers.get(topic)
        if handlers:
            try:
                handlers.remove(handler)
                log_debug(f"Unsubscribed handler from topic: {topic}")
            except ValueError:
                pass

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
                    payload=job_data.get("payload", {}),
                    origin=job_data.get("origin", "system"),
                    priority=job.opts.get("priority", 50),
                    attempts=job.attemptsMade,
                    max_attempts=job.opts.get("attempts", 3),
                    reply_to=job_data.get("reply_to"),
                    correlation_id=job_data.get("correlation_id"),
                    principal_id=job_data.get("principal_id"),
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
                    log_debug(f"No handlers for topic: {actual_topic}")
                    return

                # Execute all handlers concurrently
                await asyncio.gather(*[self._call_handler(h, env) for h in matching_handlers])

                self._stats["delivered"] += 1
                log_debug(f"Processed job {job.id} for topic {actual_topic}")

                # Do not resolve futures here; reply handling is managed by request()'s temporary subscriber

            except Exception as e:
                log_error(
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
        log_info(f"Created BullMQ worker for queue: {queue_name}")

    async def _call_handler(self, handler: Handler, env: Envelope) -> None:
        """Call a handler with error handling.

        Args:
            handler: Handler function
            env: Message envelope
        """
        try:
            await handler(env)
        except Exception as e:
            log_error(f"Error in handler for topic {env.type}: {e}", exc_info=True)
            raise

    def _on_job_failed(self, job, error) -> None:
        """Handle failed jobs (dead-letter).

        Args:
            job: Failed job
            error: Error that caused failure
        """
        self._stats["dead_letters"] += 1
        log_error(
            f"Job {job.id} moved to dead-letter: {error}", exc_info=bool(error) if error else False
        )

    @staticmethod
    def _is_ephemeral_reply_queue_name(name: str) -> bool:
        """True for per-request RPC reply queues (``reply.{Model}.{uuid}``)."""
        return name.startswith("reply.")

    async def _async_teardown_topic(self, topic: str) -> None:
        """Close and drop BullMQ worker/queue for a one-shot ``reply.*`` consumer.

        ``request()`` subscribes a unique ``reply.{Model}.{uuid}`` per call; without
        teardown, each call leaks a Worker (and FDs) until EMFILE.
        """
        if not self._is_ephemeral_reply_queue_name(topic):
            return
        if self._handlers.get(topic):
            return

        self._handlers.pop(topic, None)

        worker = self._workers.pop(topic, None)
        if worker is not None:
            try:
                await worker.close()
                log_debug(f"Tore down BullMQ worker for ephemeral reply queue: {topic}")
            except Exception as e:
                log_debug(f"Error closing worker for {topic}: {e}")

        queue = self._queues.pop(topic, None)
        if queue is not None:
            try:
                await queue.close()
                log_debug(f"Tore down BullMQ queue for ephemeral reply: {topic}")
            except Exception as e:
                log_debug(f"Error closing queue for {topic}: {e}")

    async def _async_close_ephemeral_reply_queue_after_publish(self, queue_name: str) -> None:
        """Responders only ``publish`` to ``reply.*``; drop the Queue after ``add`` to avoid FD leaks."""
        if not self._is_ephemeral_reply_queue_name(queue_name):
            return
        queue = self._queues.pop(queue_name, None)
        if queue is None:
            return
        try:
            await queue.close()
            log_debug(f"Closed ephemeral reply publish queue: {queue_name}")
        except Exception as e:
            log_debug(f"Error closing ephemeral reply queue {queue_name}: {e}")

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
        mesh: bool = False,
        priority: int = 50,
        origin: str = "internal",
        reliable: bool = True,
        ttl_ms: int | None = None,
        max_attempts: int = 3,
        reply_to: str | None = None,
        principal_id: str | None = None,
        correlation_id: str | None = None,
    ) -> None:
        """Publish a message to a topic.

        Args:
            topic: Topic name (queue name in BullMQ)
            message: Message payload
            event: True for broadcast, False for point-to-point
            mesh: Accepted for API compatibility with MeshBus (ignored by BullMQBus)
            priority: Job priority (0=highest, 99=lowest)
            origin: Message origin
            reliable: Whether to guarantee delivery (with retries)
            ttl_ms: Job time-to-live in milliseconds
            max_attempts: Maximum retry attempts
            reply_to: Optional reply topic for request/response pattern
            correlation_id: Echoed on Envelope for request/response matching

        Raises:
            ValueError: If topic validation is enabled and topic is invalid
        """
        if not self._available:
            raise RuntimeError("BullMQ not available")

        # Validate topic if enabled (skip dynamic reply topics)
        # Only validate commands/queries (event=False) - events don't need contracts
        if self._validate_topics and not topic.startswith("reply.") and not event:
            # Commands/queries must be registered as contracts
            contracts = all_contracts()
            if not any(topic == (c.bus_topic or c.name) for c in contracts.values()):
                available_topics = [c.bus_topic or c.name for c in contracts.values()][:10]
                error_msg = f"Topic '{topic}' is not registered in the contract registry.\n  Available topics: {', '.join(available_topics)}"
                log_error(error_msg)
                raise ValueError(error_msg)

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
            "payload": message.model_dump(mode="json")
            if hasattr(message, "model_dump")
            else message,
            "origin": origin,
            "reply_to": reply_to,
            "principal_id": principal_id,
            "correlation_id": correlation_id,
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

        log_debug(
            f"Published message to BullMQ queue {queue_name} (topic: {topic}) "
            f"with priority {priority}"
        )

        # One-shot reply jobs: do not keep Queue clients forever (each unique reply_to leaks FDs).
        await self._async_close_ephemeral_reply_queue_after_publish(queue_name)

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
        principal_id: str | None = None,
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
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._response_futures[correlation_id] = fut

        # Subscribe to reply topic (one-time handler)
        async def _on_reply(env: Envelope) -> None:
            """Handle reply message; match LocalBus logic + correlation_id."""
            if env.correlation_id != correlation_id or fut.done():
                return

            if hasattr(env.payload, "model_dump"):
                try:
                    result_data = env.payload.model_dump()
                except Exception as e:
                    log_error(f"Failed to dump reply model: {e}")
                    result_data = {"data": str(env.payload)}
            elif isinstance(env.payload, dict):
                result_data = env.payload
            else:
                log_warning(f"Reply handler: unexpected payload type {type(env.payload)}")
                result_data = {"data": str(env.payload)}

            if isinstance(result_data, dict) and "ok" in result_data:
                fut.set_result(QueryResult(**result_data))
            elif isinstance(result_data, dict) and "error" in result_data and result_data["error"]:
                error_msg = result_data.get("error", "Unknown service error")
                fut.set_result(QueryResult(ok=False, error=error_msg, data=result_data))
            else:
                fut.set_result(QueryResult(ok=True, data=result_data))

        # Subscribe to reply topic (publish already exempts reply.* from contract validation)
        self.subscribe(reply_topic, _on_reply)

        log_debug(f"Sent request to {topic} with correlation_id {correlation_id}")

        try:
            await self.publish(
                topic,
                message,
                event=False,
                mesh=False,
                priority=priority,
                origin=origin,
                reliable=True,
                ttl_ms=ttl_ms,
                max_attempts=max_attempts,
                reply_to=reply_topic,
                principal_id=principal_id,
                correlation_id=correlation_id,
            )

            try:
                result = await asyncio.wait_for(fut, timeout)
                log_debug(f"Received response for correlation_id {correlation_id}")
                return result
            except TimeoutError:
                log_error(f"Request to {topic} timed out after {timeout}s")
                return QueryResult(ok=False, error=f"Request timeout after {timeout}s")
        finally:
            self._response_futures.pop(correlation_id, None)
            self.unsubscribe(reply_topic, _on_reply)
            await self._async_teardown_topic(reply_topic)

    def get_stats(self) -> dict:
        """Get bus statistics.

        Returns:
            Dictionary containing bus metrics
        """
        return dict(self._stats)
