import asyncio

import pytest

from app.services.gateway.webrtc.datachannel_flow import (
    DataChannelBackpressureTimeoutError,
    DataChannelClosedError,
    DataChannelFlowController,
    DataChannelFlowLimits,
    DataChannelQueueLimitExceededError,
    send_ordered_with_backpressure,
)


class FakeDataChannel:
    def __init__(self, *, buffered: int = 0, with_events: bool = True) -> None:
        self.readyState = "open"
        self.bufferedAmount = buffered
        self.bufferedAmountLowThreshold = 0
        self.sent = []
        self.listeners = {}
        self.with_events = with_events

    def send(self, data):
        self.sent.append(data)
        if isinstance(data, bytes):
            self.bufferedAmount += len(data)
        else:
            self.bufferedAmount += len(data.encode("utf-8"))

    def on(self, event_name, callback=None):
        if not self.with_events:
            raise AttributeError("events unsupported")
        if callback is None:

            def decorator(func):
                self.listeners.setdefault(event_name, []).append(func)
                return func

            return decorator
        self.listeners.setdefault(event_name, []).append(callback)
        return callback

    def remove_listener(self, event_name, callback):
        self.listeners.get(event_name, []).remove(callback)

    def drain_to(self, amount: int) -> None:
        self.bufferedAmount = amount
        for callback in list(self.listeners.get("bufferedamountlow", [])):
            callback()

    def close(self, *, emit_bufferedamountlow: bool = True, emit_close: bool = True) -> None:
        self.readyState = "closed"
        if emit_bufferedamountlow:
            for callback in list(self.listeners.get("bufferedamountlow", [])):
                callback()
        if emit_close:
            for callback in list(self.listeners.get("close", [])):
                callback()


def limits(**overrides) -> DataChannelFlowLimits:
    values = {
        "high_watermark_bytes": 10,
        "low_watermark_bytes": 3,
        "max_queue_messages": 4,
        "max_queue_bytes": 64,
        "poll_interval_seconds": 0.001,
        "drain_timeout_seconds": 0.05,
    }
    values.update(overrides)
    return DataChannelFlowLimits(**values)


@pytest.mark.asyncio
async def test_immediate_send_preserves_order_without_waiting():
    channel = FakeDataChannel()

    sent = await send_ordered_with_backpressure(channel, ["a", b"bc"], limits=limits())

    assert sent == 2
    assert channel.sent == ["a", b"bc"]
    assert channel.listeners.get("bufferedamountlow", []) == []


@pytest.mark.asyncio
async def test_waits_for_bufferedamountlow_event_then_sends():
    channel = FakeDataChannel(buffered=9)
    controller = DataChannelFlowController(channel, limits=limits())

    send_task = asyncio.create_task(controller.send_many(["abcd"]))
    await asyncio.sleep(0)
    assert channel.sent == []
    assert len(channel.listeners["bufferedamountlow"]) == 1
    assert len(channel.listeners["close"]) == 1

    channel.drain_to(2)

    assert await send_task == 1
    assert channel.sent == ["abcd"]
    assert channel.listeners.get("bufferedamountlow", []) == []
    assert channel.listeners.get("close", []) == []
    assert controller.pending_waiter_count == 0


@pytest.mark.asyncio
async def test_polling_fallback_sends_after_drain():
    channel = FakeDataChannel(buffered=9, with_events=False)

    async def drain_later() -> None:
        await asyncio.sleep(0.005)
        channel.bufferedAmount = 2

    drain_task = asyncio.create_task(drain_later())
    try:
        assert await send_ordered_with_backpressure(channel, ["abc"], limits=limits()) == 1
    finally:
        await drain_task

    assert channel.sent == ["abc"]


@pytest.mark.asyncio
async def test_timeout_fails_closed_without_listener_leak():
    channel = FakeDataChannel(buffered=99)
    controller = DataChannelFlowController(channel, limits=limits(drain_timeout_seconds=0.005))

    with pytest.raises(DataChannelBackpressureTimeoutError):
        await controller.send_many(["abc"])

    assert channel.sent == []
    assert channel.listeners.get("bufferedamountlow", []) == []
    assert channel.listeners.get("close", []) == []
    assert controller.pending_waiter_count == 0


@pytest.mark.asyncio
async def test_close_while_waiting_aborts_without_send():
    channel = FakeDataChannel(buffered=99)
    controller = DataChannelFlowController(channel, limits=limits(drain_timeout_seconds=0.02))

    send_task = asyncio.create_task(controller.send_many(["abc"]))
    await asyncio.sleep(0)
    channel.close()

    with pytest.raises(DataChannelClosedError):
        await send_task
    assert channel.sent == []
    assert controller.pending_waiter_count == 0


@pytest.mark.asyncio
async def test_close_event_alone_aborts_wait_immediately():
    channel = FakeDataChannel(buffered=99)
    controller = DataChannelFlowController(channel, limits=limits(drain_timeout_seconds=1.0))

    send_task = asyncio.create_task(controller.send_many(["abc"]))
    await asyncio.sleep(0)
    channel.close(emit_bufferedamountlow=False, emit_close=True)

    with pytest.raises(DataChannelClosedError):
        await send_task
    assert channel.sent == []
    assert channel.listeners.get("bufferedamountlow", []) == []
    assert channel.listeners.get("close", []) == []
    assert controller.pending_waiter_count == 0


@pytest.mark.asyncio
async def test_default_queue_limit_accepts_8_mib_logical_payload_with_json_overhead():
    payload = "x" * (8 * 1024 * 1024 + 4096)
    channel = FakeDataChannel()
    controller = DataChannelFlowController(
        channel,
        limits=DataChannelFlowLimits(
            high_watermark_bytes=16 * 1024 * 1024,
            low_watermark_bytes=1024 * 1024,
            max_queue_bytes=16 * 1024 * 1024,
        ),
    )

    assert await controller.send_many([payload]) == 1
    assert channel.sent == [payload]


@pytest.mark.asyncio
async def test_order_preservation_across_multiple_drain_events():
    channel = FakeDataChannel()
    controller = DataChannelFlowController(
        channel, limits=limits(high_watermark_bytes=3, low_watermark_bytes=1)
    )

    send_task = asyncio.create_task(controller.send_many(["aa", "bb", "cc"]))
    await asyncio.sleep(0)
    assert channel.sent == ["aa"]
    channel.drain_to(0)
    for _ in range(10):
        if channel.sent == ["aa", "bb"]:
            break
        await asyncio.sleep(0)
    assert channel.sent == ["aa", "bb"]
    channel.drain_to(0)

    assert await send_task == 3
    assert channel.sent == ["aa", "bb", "cc"]


@pytest.mark.asyncio
async def test_queue_count_and_byte_limits_are_rejected_before_send():
    channel = FakeDataChannel()

    with pytest.raises(DataChannelQueueLimitExceededError):
        await send_ordered_with_backpressure(channel, ["a", "b", "c", "d", "e"], limits=limits())
    with pytest.raises(DataChannelQueueLimitExceededError):
        await send_ordered_with_backpressure(channel, ["x" * 65], limits=limits())

    assert channel.sent == []


@pytest.mark.asyncio
async def test_cancellation_cleans_waiter_and_listener():
    channel = FakeDataChannel(buffered=99)
    controller = DataChannelFlowController(channel, limits=limits(drain_timeout_seconds=1.0))

    send_task = asyncio.create_task(controller.send_many(["abc"]))
    await asyncio.sleep(0)
    assert controller.pending_waiter_count == 1
    send_task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await send_task
    assert controller.pending_waiter_count == 0
    assert channel.listeners.get("bufferedamountlow", []) == []
    assert channel.listeners.get("close", []) == []


@pytest.mark.asyncio
async def test_independent_channels_do_not_block_each_other():
    blocked = FakeDataChannel(buffered=99)
    free = FakeDataChannel()
    blocked_controller = DataChannelFlowController(
        blocked, limits=limits(drain_timeout_seconds=0.05)
    )
    free_controller = DataChannelFlowController(free, limits=limits())

    blocked_task = asyncio.create_task(blocked_controller.send_many(["blocked"]))
    await asyncio.sleep(0)

    assert await free_controller.send_many(["free"]) == 1
    assert free.sent == ["free"]
    assert blocked.sent == []

    blocked_task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await blocked_task


@pytest.mark.asyncio
async def test_closed_before_send_raises_closed_error():
    channel = FakeDataChannel()
    channel.close()

    with pytest.raises(DataChannelClosedError):
        await send_ordered_with_backpressure(channel, ["x"], limits=limits())
