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
from collections import defaultdict

from pydantic import BaseModel

from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.shared.contracts.registry import all_contracts

from .bus import Envelope, Handler, QueryResult


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
        self._cmd_queues: dict[str, asyncio.PriorityQueue] = defaultdict(
            lambda: asyncio.PriorityQueue(maxsize=command_queue_size)
        )

        # Event queues (FIFO)
        self._evt_queues: dict[str, asyncio.Queue] = defaultdict(
            lambda: asyncio.Queue(maxsize=event_queue_size)
        )

        # Worker tracking
        self._cmd_workers_started: dict[str, bool] = defaultdict(bool)
        self._evt_workers_started: dict[str, bool] = defaultdict(bool)

        # Shutdown signal
        self._shutdown = asyncio.Event()

        # Dead-letter queue for failed commands
        self._dead_letter: asyncio.Queue = asyncio.Queue()

        # Topic validation
        self._validate_topics = validate_topics

        # Counter for tiebreaking in priority queue (ensures FIFO for same priority)
        self._counter = 0

        # Metrics
        self._stats = {
            "published": 0,
            "delivered": 0,
            "retries": 0,
            "dead_letters": 0,
        }

    async def start(self) -> None:
        """Start the message bus."""
        log_info("LocalBus started")

    async def stop(self) -> None:
        """Stop the message bus and cleanup resources."""
        log_info("Stopping LocalBus...")
        self._shutdown.set()
        await asyncio.sleep(0.1)  # Give workers time to finish
        log_info("LocalBus stopped")

    def subscribe(self, topic: str, handler: Handler) -> None:
        """Subscribe to a topic with a handler.

        Args:
            topic: Topic name (supports wildcards like "TTS.*")
            handler: Async function to handle messages

        Raises:
            ValueError: If topic validation is enabled and topic is invalid
        """
        # Note: Subscriptions are always allowed for events.
        # Events don't need to be registered as contracts - they're published and subscribed to.
        # Only callable methods (queries/commands) need @method_contract decorators.
        # We don't validate subscriptions because services may subscribe to events
        # that are published by other services without contracts.

        self._subs[topic].append(handler)
        log_debug(f"Subscribed handler to topic: {topic}")

        # Wildcard patterns (e.g. TTS.*) match concrete topics; events are queued per
        # concrete topic only — do not start an idle worker for the pattern key.
        if "*" in topic:
            return

        # Start event worker for this topic if not already started
        if not self._evt_workers_started[topic]:
            self._evt_workers_started[topic] = True
            asyncio.create_task(self._event_worker(topic))

    def unsubscribe(self, topic: str, handler: Handler) -> None:
        """Remove a handler previously registered with ``subscribe``."""
        handlers = self._subs.get(topic)
        if not handlers:
            return
        try:
            handlers.remove(handler)
            log_debug(f"Unsubscribed handler from topic: {topic}")
        except ValueError:
            pass

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
            log_debug(f"No subscribers for topic: {topic}")
            return

        # Run all handlers concurrently
        async def _run_handler(handler):
            try:
                await handler(env)
                self._stats["delivered"] += 1
            except Exception as e:
                log_error(
                    f"Error in handler for topic {topic}: {e}",
                    exc_info=True,
                )
                if raise_errors:
                    raise
                return e
            return None

        # Execute all handlers concurrently
        results = await asyncio.gather(
            *[_run_handler(h) for h in matching_handlers], return_exceptions=not raise_errors
        )

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
        log_debug(f"Event worker started for topic: {topic}")

        while not self._shutdown.is_set():
            try:
                env = await asyncio.wait_for(queue.get(), timeout=0.1)
                await self._deliver(topic, env)
                queue.task_done()
            except TimeoutError:
                continue
            except Exception as e:
                log_error(f"Error in event worker for {topic}: {e}")

    async def _command_worker(self, topic: str) -> None:
        """Worker for processing command messages with retry logic.

        Args:
            topic: Topic to process commands for
        """
        queue = self._cmd_queues[topic]
        log_info(f"Command worker started for topic: {topic}")

        while not self._shutdown.is_set():
            try:
                # Get prioritized command (priority, counter, envelope)
                prio, _counter, env = await asyncio.wait_for(queue.get(), timeout=0.1)

                try:
                    await self._deliver(topic, env, raise_errors=True)
                except Exception as e:
                    log_error(
                        f"Error delivering command to {topic} "
                        f"(attempt {env.attempts + 1}/{env.max_attempts}): {e}"
                    )

                    # Retry with exponential backoff
                    env.attempts += 1
                    if env.attempts < env.max_attempts:
                        self._stats["retries"] += 1
                        # Calculate backoff delay
                        delay = min(0.25 * (2**env.attempts), 10.0)
                        await asyncio.sleep(delay)
                        # Re-queue with same priority and new counter
                        queue.task_done()  # Mark current task done before re-queueing
                        self._counter += 1
                        await queue.put((prio, self._counter, env))
                        log_info(
                            f"Re-queued command {env.id} to {topic} "
                            f"(attempt {env.attempts}/{env.max_attempts})"
                        )
                    else:
                        # Dead-letter
                        self._stats["dead_letters"] += 1
                        await self._dead_letter.put(env)
                        log_error(
                            f"Command {env.id} to {topic} exceeded max attempts, "
                            f"moved to dead-letter queue"
                        )
                        queue.task_done()
                else:
                    # Success case
                    queue.task_done()

            except TimeoutError:
                continue
            except Exception as e:
                log_error(f"Error in command worker for {topic}: {e}")

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
            topic: Topic name
            message: Message payload
            event: True for broadcast events, False for point-to-point commands
            mesh: Accepted for API compatibility with MeshBus (ignored by LocalBus)
            priority: Message priority (0=highest, 99=lowest)
            origin: Message origin
            reliable: Whether to guarantee delivery (with retries)
            ttl_ms: Time-to-live in milliseconds (not implemented yet)
            max_attempts: Maximum retry attempts
            reply_to: Optional reply topic for request/response pattern

        Raises:
            ValueError: If topic validation is enabled and topic is invalid
        """
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

        env = Envelope(
            type=topic,
            payload=message,
            origin=origin,
            priority=priority,
            max_attempts=max_attempts if reliable else 1,
            reply_to=reply_to,
            principal_id=principal_id,
            correlation_id=correlation_id,
        )

        self._stats["published"] += 1

        if event:
            # Event: broadcast to all subscribers
            if not self._evt_workers_started[topic]:
                self._evt_workers_started[topic] = True
                asyncio.create_task(self._event_worker(topic))

            try:
                await self._evt_queues[topic].put(env)
                log_debug(f"Published event to {topic}")
            except asyncio.QueueFull:
                log_warning(f"Event queue full for {topic}, dropping message")
        else:
            # Command: point-to-point with priority
            if not self._cmd_workers_started[topic]:
                self._cmd_workers_started[topic] = True
                asyncio.create_task(self._command_worker(topic))

            try:
                # Use counter as tiebreaker to ensure FIFO for same priority
                self._counter += 1
                await self._cmd_queues[topic].put((priority, self._counter, env))
                log_debug(f"Published command to {topic} with priority {priority}")
            except asyncio.QueueFull:
                log_error(f"Command queue full for {topic}, cannot publish")
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
        principal_id: str | None = None,
        correlation_id: str | None = None,
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

        request_correlation_id = correlation_id or str(uuid_lib.uuid4())

        # Create a future for the response
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        reply_topic = f"reply.{message.__class__.__name__}.{request_correlation_id}"

        # Subscribe to reply topic (skip validation for dynamic reply topics)
        async def _on_reply(env: Envelope) -> None:
            if not fut.done():
                # Handle both BaseModel instances and dict payloads
                result_data = None

                # Check if it's a BaseModel instance (not the class itself)
                if hasattr(env.payload, "__class__") and hasattr(
                    env.payload.__class__, "model_dump"
                ):
                    try:
                        result_data = env.payload.model_dump()
                        log_debug(f"Reply handler: model_dump result = {result_data}")
                    except Exception as e:
                        log_error(f"Failed to dump model: {e}")
                        result_data = {"data": str(env.payload)}
                elif isinstance(env.payload, dict):
                    result_data = env.payload
                    log_debug(f"Reply handler: dict payload = {result_data}")
                else:
                    # Unexpected payload type, wrap it
                    log_warning(f"Reply handler: unexpected payload type {type(env.payload)}")
                    result_data = {"data": str(env.payload)}

                # If result_data has 'ok' field, it's already a QueryResult-like structure
                if isinstance(result_data, dict) and "ok" in result_data:
                    log_debug("Reply handler: Creating QueryResult from dict with ok field")
                    fut.set_result(QueryResult(**result_data))
                elif (
                    isinstance(result_data, dict)
                    and "error" in result_data
                    and result_data["error"]
                ):
                    # ErrorOutput response - service returned an error
                    error_msg = result_data.get("error", "Unknown service error")
                    log_debug(f"Reply handler: ErrorOutput received: {error_msg}")
                    fut.set_result(QueryResult(ok=False, error=error_msg, data=result_data))
                else:
                    # Wrap the data in a successful QueryResult
                    log_debug("Reply handler: Wrapping data in QueryResult")
                    fut.set_result(QueryResult(ok=True, data=result_data))

        # Reply topics are not validated on publish when topic starts with "reply."
        self.subscribe(reply_topic, _on_reply)

        # Publish request with reply_to field
        try:
            await self.publish(
                topic,
                message,
                event=False,
                priority=priority,
                origin=origin,
                max_attempts=max_attempts,
                reply_to=reply_topic,
                principal_id=principal_id,
                correlation_id=request_correlation_id,
            )

            # Wait for response
            try:
                result = await asyncio.wait_for(fut, timeout)
                return result
            except TimeoutError:
                log_error(f"Request to {topic} timed out after {timeout}s")
                return QueryResult(ok=False, error=f"Request timeout after {timeout}s")
        finally:
            self.unsubscribe(reply_topic, _on_reply)

    def get_stats(self) -> dict:
        """Get bus statistics.

        Returns:
            Dictionary containing bus metrics
        """
        return dict(self._stats)
