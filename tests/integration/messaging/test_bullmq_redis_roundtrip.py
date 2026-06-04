"""Live Redis + BullMQ round-trip tests for BullMQBus.

Requires bullmq (aurora[mode-processes]) and Redis at REDIS_URL
(default redis://127.0.0.1:6379). Skips when Redis is unreachable.
"""

from __future__ import annotations

import asyncio
import os
import uuid

import pytest
from pydantic import BaseModel

pytest.importorskip("bullmq")

try:
    import redis as redis_sync
except ImportError:
    redis_sync = None  # type: ignore[assignment]

pytest.importorskip("redis")

from app.messaging.bullmq_bus import BullMQBus
from app.messaging.bus import Envelope, QueryResult


def _redis_url() -> str:
    return os.environ.get("REDIS_URL", "redis://127.0.0.1:6379")


@pytest.fixture
def redis_live():
    """Skip if Redis is not reachable (no redis-py or connection error)."""
    if redis_sync is None:
        pytest.skip("redis package missing")
    client = redis_sync.Redis.from_url(_redis_url(), decode_responses=True)
    try:
        client.ping()
    except redis_sync.ConnectionError:
        pytest.skip("Redis not reachable — start Redis or set REDIS_URL")
    yield client
    client.close()


class _PingPayload(BaseModel):
    x: int


class _RpcIn(BaseModel):
    message: str


@pytest.mark.integration
@pytest.mark.process_mode
@pytest.mark.bullmq_redis
class TestBullMQRedisRoundtrip:
    """End-to-end BullMQBus against a real Redis."""

    @pytest.mark.asyncio
    async def test_command_publish_delivered_to_handler(self, redis_live) -> None:
        """A command job is consumed by a Worker and passed to the handler."""
        ns = uuid.uuid4().hex[:12]
        topic = f"AuroraTest.Bullmq.{ns}.Ping"
        bus = BullMQBus(redis_url=_redis_url(), validate_topics=False)
        await bus.start()
        received: dict[str, object] = {}

        async def handler(env: Envelope) -> None:
            received["payload"] = env.payload

        bus.subscribe(topic, handler)
        await asyncio.sleep(0.75)

        try:
            await bus.publish(topic, _PingPayload(x=7), event=False, origin="integration-test")
            loop = asyncio.get_running_loop()
            deadline = loop.time() + 15.0
            while loop.time() < deadline:
                if "payload" in received:
                    break
                await asyncio.sleep(0.05)
            assert "payload" in received
            payload = received["payload"]
            assert isinstance(payload, dict)
            assert payload.get("x") == 7
        finally:
            await bus.stop()

    @pytest.mark.asyncio
    async def test_request_response_two_bus_instances(self, redis_live) -> None:
        """Client request() completes when a peer bus handles the job and replies."""
        ns = uuid.uuid4().hex[:12]
        cmd_topic = f"AuroraTest.Bullmq.{ns}.Rpc"

        server = BullMQBus(redis_url=_redis_url(), validate_topics=False)
        client = BullMQBus(redis_url=_redis_url(), validate_topics=False)
        await server.start()
        await client.start()

        async def rpc_handler(env: Envelope) -> None:
            if env.reply_to and env.correlation_id:
                body = env.payload if isinstance(env.payload, dict) else {}
                pong = str(body.get("message", ""))
                await server.publish(
                    env.reply_to,
                    QueryResult(ok=True, data={"pong": pong}),
                    event=False,
                    correlation_id=env.correlation_id,
                )

        server.subscribe(cmd_topic, rpc_handler)
        await asyncio.sleep(0.75)

        try:
            result = await client.request(
                cmd_topic,
                _RpcIn(message="hello-redis"),
                timeout=20.0,
                origin="integration-test-client",
            )
            assert result.ok is True
            assert result.data is not None
            assert result.data["pong"] == "hello-redis"
        finally:
            await client.stop()
            await server.stop()
