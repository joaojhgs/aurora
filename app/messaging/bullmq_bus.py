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
import contextlib
import json
import uuid as uuid_lib
from collections import defaultdict

from pydantic import BaseModel

from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.shared.contracts.models.speech import SpeechRouteBinding
from app.shared.contracts.registry import all_contracts

from .bus import Envelope, Handler, QueryResult, query_result_from_reply_payload


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
        self._event_handlers: dict[str, list[Handler]] = defaultdict(list)
        self._event_wildcard_patterns: dict[str, list[Handler]] = defaultdict(list)
        self._event_patterns: set[str] = set()
        self._event_pattern_tasks: dict[str, asyncio.Task[None]] = {}
        self._event_pattern_readiness_lock = asyncio.Lock()
        self._event_worker_queues: dict[str, str] = {}
        self._redis = None
        self._pubsub = None
        self._pubsub_task: asyncio.Task | None = None
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
        try:
            for topic in list(self._event_handlers):
                await self._ensure_event_subscription_ready(topic, pattern=False)
            for pattern in list(self._event_wildcard_patterns):
                await self._ensure_event_subscription_ready(pattern, pattern=True)
        except Exception:
            self._started = False
            raise
        log_info(f"BullMQBus started with Redis at {self.redis_url}")

    async def stop(self) -> None:
        """Stop the message bus and cleanup resources."""
        log_info("Stopping BullMQBus...")

        async def _close_worker(topic, worker):
            try:
                await worker.close()
                log_debug(f"Closed worker for topic: {topic}")
            except Exception as e:
                log_error(f"Error closing worker for {topic}: {e}")

        # Worker shutdown may wait on Redis independently per queue. Closing
        # hundreds of process-mode service workers serially makes clean restart
        # take minutes and leaves stale locks when supervisors reach their
        # timeout. They are independent resources, so close them concurrently.
        await asyncio.gather(
            *(_close_worker(topic, worker) for topic, worker in list(self._workers.items()))
        )

        async def _close_queue(topic, queue):
            try:
                await queue.close()
                log_debug(f"Closed queue for topic: {topic}")
            except Exception as e:
                log_error(f"Error closing queue for {topic}: {e}")

        await asyncio.gather(
            *(_close_queue(topic, queue) for topic, queue in list(self._queues.items()))
        )

        if self._pubsub_task:
            self._pubsub_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._pubsub_task
            self._pubsub_task = None

        for task in list(self._event_pattern_tasks.values()):
            task.cancel()
        if self._event_pattern_tasks:
            await asyncio.gather(
                *self._event_pattern_tasks.values(),
                return_exceptions=True,
            )
            self._event_pattern_tasks.clear()

        if self._pubsub is not None:
            try:
                await self._pubsub.close()
            except Exception as e:
                log_debug(f"Error closing Redis pubsub: {e}")
            self._pubsub = None

        if self._redis is not None:
            for topic, queue_name in list(self._event_worker_queues.items()):
                try:
                    await self._redis.srem(self._event_subscriber_key(topic), queue_name)
                except Exception as e:
                    log_debug(f"Error unregistering event subscriber {queue_name}: {e}")
            try:
                await self._redis.close()
            except Exception as e:
                log_debug(f"Error closing Redis client: {e}")
            self._redis = None

        self._started = False
        log_info("BullMQBus stopped")

    def subscribe(self, topic: str, handler: Handler, *, event: bool = False) -> None:
        """Subscribe to a topic with a handler.

        Creates a BullMQ worker to process jobs for the topic.

        Args:
            topic: Topic name (supports wildcards like "TTS.*")
            handler: Async function to handle messages
            event: True when subscribing to broadcast fanout instead of a command queue

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

        if self._is_event_topic(topic, event=event):
            if "*" in topic:
                self._event_wildcard_patterns[topic].append(handler)
                self._ensure_event_subscription(topic, pattern=True)
            else:
                self._event_handlers[topic].append(handler)
                self._ensure_event_subscription(topic, pattern=False)
            log_debug(f"Subscribed event handler to topic: {topic}")
            return

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

    async def subscribe_event(self, topic: str, handler: Handler) -> None:
        """Subscribe to an event topic and wait for Redis/BullMQ readiness."""
        if not self._available:
            raise RuntimeError("BullMQ not available")
        if not self._is_event_topic(topic, event=True):
            raise ValueError(f"Topic cannot be subscribed as an event: {topic}")

        pattern = "*" in topic
        handlers = self._event_wildcard_patterns[topic] if pattern else self._event_handlers[topic]
        transport_was_ready = (
            topic in self._event_patterns if pattern else topic in self._event_worker_queues
        )
        handlers.append(handler)
        try:
            await self._ensure_event_subscription_ready(topic, pattern=pattern)
            log_debug(f"Subscribed event handler to topic: {topic}")
        except Exception:
            with contextlib.suppress(ValueError):
                handlers.remove(handler)
            if not handlers:
                if pattern:
                    self._event_wildcard_patterns.pop(topic, None)
                else:
                    self._event_handlers.pop(topic, None)
            if not transport_was_ready and not pattern:
                await self._rollback_event_subscription(topic, pattern=pattern)
            raise

    def unsubscribe(self, topic: str, handler: Handler) -> None:
        """Remove a handler previously registered with ``subscribe``."""
        if "*" in topic:
            event_handlers = self._event_wildcard_patterns.get(topic)
            if event_handlers:
                try:
                    event_handlers.remove(handler)
                    log_debug(f"Unsubscribed event wildcard handler from pattern: {topic}")
                except ValueError:
                    pass
                return
            handlers = self._wildcard_patterns.get(topic)
            if handlers:
                try:
                    handlers.remove(handler)
                    log_debug(f"Unsubscribed wildcard handler from pattern: {topic}")
                except ValueError:
                    pass
            return
        event_handlers = self._event_handlers.get(topic)
        if event_handlers:
            try:
                event_handlers.remove(handler)
                log_debug(f"Unsubscribed event handler from topic: {topic}")
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

    def _is_event_topic(self, topic: str, *, event: bool = False) -> bool:
        """Return True when a subscription should use broadcast fanout."""
        if topic.startswith("reply."):
            return False
        if event:
            return True
        if "*" in topic:
            return False
        if not self._validate_topics:
            return False
        contracts = all_contracts()
        return not any(topic == (c.bus_topic or c.name) for c in contracts.values())

    def _ensure_event_subscription(self, topic: str, *, pattern: bool) -> None:
        """Create a per-process fanout queue for an event topic or pattern."""
        if not self._started:
            return
        if not pattern:
            if topic in self._event_worker_queues:
                return
            queue_name = f"event.{topic}.{uuid_lib.uuid4()}"
            self._event_worker_queues[topic] = queue_name
            self._create_worker(queue_name)
            asyncio.create_task(self._async_register_event_queue(topic, queue_name))
            return

        if topic in self._event_patterns or topic in self._event_pattern_tasks:
            return
        self._event_pattern_tasks[topic] = asyncio.create_task(
            self._async_subscribe_event_topic(topic, pattern=True)
        )

    async def _ensure_event_subscription_ready(self, topic: str, *, pattern: bool) -> None:
        """Create event transport resources and wait until Redis has acknowledged them."""
        if not self._started:
            return
        if not pattern:
            queue_name = self._event_worker_queues.get(topic)
            if queue_name is None:
                queue_name = f"event.{topic}.{uuid_lib.uuid4()}"
                self._event_worker_queues[topic] = queue_name
                self._create_worker(queue_name)
            await self._register_event_queue_ready(topic, queue_name)
            return

        if topic in self._event_patterns:
            return
        async with self._event_pattern_readiness_lock:
            if topic in self._event_patterns:
                return
            pending_task = self._event_pattern_tasks.get(topic)
            if pending_task is not None:
                await pending_task
                if topic in self._event_patterns:
                    return
            try:
                await self._subscribe_event_topic_ready(topic, pattern=True)
                self._event_patterns.add(topic)
            except Exception:
                self._event_patterns.discard(topic)
                raise

    async def _rollback_event_subscription(self, topic: str, *, pattern: bool) -> None:
        """Undo readiness state created for a failed subscribe_event call."""
        if pattern:
            self._event_patterns.discard(topic)
            self._event_pattern_tasks.pop(topic, None)
            return

        queue_name = self._event_worker_queues.pop(topic, None)
        if queue_name is None:
            return
        if self._redis is not None:
            with contextlib.suppress(Exception):
                await self._redis.srem(self._event_subscriber_key(topic), queue_name)
        worker = self._workers.pop(queue_name, None)
        if worker is not None:
            with contextlib.suppress(Exception):
                await worker.close()

    @staticmethod
    def _event_subscriber_key(topic: str) -> str:
        return f"aurora:event-subscribers:{topic}"

    async def _register_event_queue_ready(self, topic: str, queue_name: str) -> None:
        redis = await self._get_redis()
        await redis.sadd(self._event_subscriber_key(topic), queue_name)
        log_info(f"Registered BullMQ event fanout queue: {topic} -> {queue_name}")

    async def _async_register_event_queue(self, topic: str, queue_name: str) -> None:
        try:
            await self._register_event_queue_ready(topic, queue_name)
        except Exception as e:
            log_error(f"Error registering event fanout queue {queue_name}: {e}", exc_info=True)

    async def _get_redis(self):
        if self._redis is None:
            from redis.asyncio import from_url

            self._redis = from_url(self.redis_url)
        return self._redis

    async def _ensure_pubsub(self):
        if self._pubsub is None:
            redis = await self._get_redis()
            self._pubsub = redis.pubsub()
        return self._pubsub

    def _ensure_pubsub_listener(self) -> None:
        if self._pubsub_task is None or self._pubsub_task.done():
            self._pubsub_task = asyncio.create_task(self._pubsub_listener())

    async def _async_subscribe_event_topic(self, topic: str, *, pattern: bool) -> None:
        try:
            await self._subscribe_event_topic_ready(topic, pattern=pattern)
            if pattern:
                self._event_patterns.add(topic)
        except Exception as e:
            log_error(f"Error subscribing to event channel {topic}: {e}", exc_info=True)
        finally:
            if pattern:
                self._event_pattern_tasks.pop(topic, None)

    async def _subscribe_event_topic_ready(self, topic: str, *, pattern: bool) -> None:
        pubsub = await self._ensure_pubsub()
        if pattern:
            await pubsub.psubscribe(topic)
        else:
            await pubsub.subscribe(topic)
        self._ensure_pubsub_listener()
        log_info(f"Subscribed Redis pub/sub event channel: {topic}")

    async def _pubsub_listener(self) -> None:
        """Redis pub/sub listener for broadcast events."""
        try:
            async for message in self._pubsub.listen():
                message_type = message.get("type")
                if isinstance(message_type, bytes):
                    message_type = message_type.decode("utf-8")
                if message_type not in {"message", "pmessage"}:
                    continue
                try:
                    raw = message.get("data")
                    if isinstance(raw, bytes):
                        raw = raw.decode("utf-8")
                    data = json.loads(raw)
                    actual_topic = data.get("type")
                    if not actual_topic:
                        continue

                    env = Envelope(
                        id=data.get("id"),
                        type=actual_topic,
                        payload=data.get("payload", {}),
                        origin=data.get("origin", "system"),
                        priority=data.get("priority", 50),
                        attempts=data.get("attempts", 0),
                        max_attempts=data.get("max_attempts", 1),
                        reply_to=data.get("reply_to"),
                        correlation_id=data.get("correlation_id"),
                        principal_id=data.get("principal_id"),
                        effective_perms=data.get("effective_perms"),
                        identity_source=data.get("identity_source"),
                        method_type=data.get("method_type"),
                        caller_peer_id=data.get("caller_peer_id"),
                        transport_source_id=data.get("transport_source_id"),
                        auth_grant_revision=data.get("auth_grant_revision"),
                        manifest_revision=data.get("manifest_revision"),
                        projected_service_id=data.get("projected_service_id"),
                        projected_method_id=data.get("projected_method_id"),
                        projected_method_topics=data.get("projected_method_topics"),
                        projected_method_set_digest=data.get("projected_method_set_digest"),
                        speech_route_binding=data.get("speech_route_binding"),
                    )
                    await self._deliver_event_wildcards(actual_topic, env)
                except Exception as e:
                    log_error(f"Error handling Redis pub/sub event: {e}", exc_info=True)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log_error(f"Redis pub/sub listener stopped unexpectedly: {e}", exc_info=True)

    async def _deliver_event_wildcards(self, topic: str, env: Envelope) -> None:
        """Deliver a Redis pub/sub event copy to wildcard event handlers only."""
        matching_handlers: list[Handler] = []
        for pattern, handlers in self._event_wildcard_patterns.items():
            if self._topic_matches(topic, pattern):
                matching_handlers.extend(handlers)

        if not matching_handlers:
            log_debug(f"No wildcard event handlers for topic: {topic}")
            return

        await asyncio.gather(*[self._call_handler(h, env) for h in matching_handlers])
        self._stats["delivered"] += len(matching_handlers)

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
                    effective_perms=job_data.get("effective_perms"),
                    identity_source=job_data.get("identity_source"),
                    method_type=job_data.get("method_type"),
                    caller_peer_id=job_data.get("caller_peer_id"),
                    transport_source_id=job_data.get("transport_source_id"),
                    auth_grant_revision=job_data.get("auth_grant_revision"),
                    manifest_revision=job_data.get("manifest_revision"),
                    projected_service_id=job_data.get("projected_service_id"),
                    projected_method_id=job_data.get("projected_method_id"),
                    projected_method_topics=job_data.get("projected_method_topics"),
                    projected_method_set_digest=job_data.get("projected_method_set_digest"),
                    speech_route_binding=job_data.get("speech_route_binding"),
                )

                if queue_name in self._event_worker_queues.values():
                    matching_handlers = list(self._event_handlers.get(actual_topic, []))
                    if not matching_handlers:
                        log_debug(f"No exact event handlers for topic: {actual_topic}")
                        return

                    await asyncio.gather(*[self._call_handler(h, env) for h in matching_handlers])
                    self._stats["delivered"] += len(matching_handlers)
                else:
                    # Find matching command handlers (direct + wildcard)
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
        effective_perms: list[str] | None = None,
        identity_source: str | None = None,
        method_type: str | None = None,
        caller_peer_id: str | None = None,
        transport_source_id: str | None = None,
        auth_grant_revision: int | None = None,
        manifest_revision: int | None = None,
        projected_service_id: str | None = None,
        projected_method_id: str | None = None,
        projected_method_topics: list[str] | None = None,
        projected_method_set_digest: str | None = None,
        speech_route_binding: SpeechRouteBinding | None = None,
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

        # Broadcast events are copied to one durable per-subscriber queue.
        # A single BullMQ topic queue is point-to-point and would load-balance
        # lifecycle/config events across subscribers instead of broadcasting.
        # ``reply.*`` is always a one-consumer request/response queue. Service
        # handlers historically publish replies with ``event=True`` (matching
        # LocalBus), so treating that flag as broadcast drops the response:
        # request() registers a direct Worker, not an event-subscriber set.
        if event and not self._is_ephemeral_reply_queue_name(topic):
            redis = await self._get_redis()
            subscriber_queues = await redis.smembers(self._event_subscriber_key(topic))
            job_id = str(uuid_lib.uuid4())
            job_data = {
                "id": job_id,
                "type": topic,
                "payload": message.model_dump(mode="json")
                if hasattr(message, "model_dump")
                else message,
                "origin": origin,
                "reply_to": reply_to,
                "principal_id": principal_id,
                "effective_perms": effective_perms,
                "identity_source": identity_source,
                "method_type": method_type,
                "caller_peer_id": caller_peer_id,
                "transport_source_id": transport_source_id,
                "auth_grant_revision": auth_grant_revision,
                "manifest_revision": manifest_revision,
                "projected_service_id": projected_service_id,
                "projected_method_id": projected_method_id,
                "projected_method_topics": projected_method_topics,
                "projected_method_set_digest": projected_method_set_digest,
                "speech_route_binding": _dump_speech_route_binding(speech_route_binding),
                "correlation_id": correlation_id,
                "priority": priority,
                "attempts": 0,
                "max_attempts": max_attempts if reliable else 1,
            }
            job_opts = {
                "priority": priority,
                "attempts": max_attempts if reliable else 1,
                "backoff": {
                    "type": "exponential",
                    "delay": 250,
                },
                "removeOnComplete": True,
                "removeOnFail": False,
            }
            if ttl_ms:
                job_opts["ttl"] = ttl_ms

            for raw_queue_name in subscriber_queues:
                queue_name = (
                    raw_queue_name.decode("utf-8")
                    if isinstance(raw_queue_name, bytes)
                    else raw_queue_name
                )
                if queue_name not in self._queues:
                    self._queues[queue_name] = self._Queue(
                        queue_name,
                        {"connection": self.redis_url},
                    )
                await self._queues[queue_name].add(queue_name, job_data, job_opts)
            # Wildcard event subscribers live in other processes and are not
            # visible through this publisher's local _event_patterns set.
            # Always emit the pub/sub copy so remote pattern subscribers receive
            # the broadcast; concrete subscribers still get durable queue fanout.
            await redis.publish(topic, json.dumps(job_data))
            self._stats["published"] += 1
            log_debug(f"Published event {topic} to {len(subscriber_queues)} subscriber queue(s)")
            return

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
            "effective_perms": effective_perms,
            "identity_source": identity_source,
            "method_type": method_type,
            "caller_peer_id": caller_peer_id,
            "transport_source_id": transport_source_id,
            "auth_grant_revision": auth_grant_revision,
            "manifest_revision": manifest_revision,
            "projected_service_id": projected_service_id,
            "projected_method_id": projected_method_id,
            "projected_method_topics": projected_method_topics,
            "projected_method_set_digest": projected_method_set_digest,
            "speech_route_binding": _dump_speech_route_binding(speech_route_binding),
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
        effective_perms: list[str] | None = None,
        identity_source: str | None = None,
        method_type: str | None = None,
        caller_peer_id: str | None = None,
        transport_source_id: str | None = None,
        auth_grant_revision: int | None = None,
        manifest_revision: int | None = None,
        projected_service_id: str | None = None,
        projected_method_id: str | None = None,
        projected_method_topics: list[str] | None = None,
        projected_method_set_digest: str | None = None,
        speech_route_binding: SpeechRouteBinding | None = None,
        correlation_id: str | None = None,
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

        # Generate or propagate a unique correlation ID
        request_correlation_id = correlation_id or str(uuid_lib.uuid4())
        reply_topic = f"reply.{message.__class__.__name__}.{request_correlation_id}"

        # Create future for response
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._response_futures[request_correlation_id] = fut

        # Subscribe to reply topic (one-time handler)
        async def _on_reply(env: Envelope) -> None:
            """Handle reply message; match LocalBus logic + correlation_id."""
            if env.correlation_id != request_correlation_id or fut.done():
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

            fut.set_result(query_result_from_reply_payload(result_data))

        # Subscribe to reply topic (publish already exempts reply.* from contract validation)
        self.subscribe(reply_topic, _on_reply)

        log_debug(f"Sent request to {topic} with correlation_id {request_correlation_id}")

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
                effective_perms=effective_perms,
                identity_source=identity_source,
                method_type=method_type,
                caller_peer_id=caller_peer_id,
                transport_source_id=transport_source_id,
                auth_grant_revision=auth_grant_revision,
                manifest_revision=manifest_revision,
                projected_service_id=projected_service_id,
                projected_method_id=projected_method_id,
                projected_method_topics=projected_method_topics,
                projected_method_set_digest=projected_method_set_digest,
                speech_route_binding=speech_route_binding,
                correlation_id=request_correlation_id,
            )

            try:
                result = await asyncio.wait_for(fut, timeout)
                log_debug(f"Received response for correlation_id {request_correlation_id}")
                return result
            except TimeoutError:
                log_error(f"Request to {topic} timed out after {timeout}s")
                return QueryResult(ok=False, error=f"Request timeout after {timeout}s")
        finally:
            self._response_futures.pop(request_correlation_id, None)
            self.unsubscribe(reply_topic, _on_reply)
            await self._async_teardown_topic(reply_topic)

    def get_stats(self) -> dict:
        """Get bus statistics.

        Returns:
            Dictionary containing bus metrics
        """
        return dict(self._stats)


def _dump_speech_route_binding(binding: SpeechRouteBinding | None) -> dict | None:
    if binding is None:
        return None
    return binding.model_dump(mode="json")
