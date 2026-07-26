"""Flow-control helpers for WebRTC DataChannel sends.

The gateway uses ``aiortc`` DataChannels today, while browser thin-shell peers
will exercise equivalent DataChannel semantics.  This module intentionally only
assumes the small cross-runtime surface shared by both implementations:
``readyState``, ``bufferedAmount``, ``bufferedAmountLowThreshold``, ``send()``,
and optionally ``on('bufferedamountlow', callback)``.
"""

from __future__ import annotations

import asyncio
import contextlib
import inspect
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any, Protocol, TypeAlias

DataChannelPayload: TypeAlias = str | bytes


class DataChannelLike(Protocol):
    """Minimal DataChannel protocol used by :class:`DataChannelFlowController`."""

    readyState: str  # noqa: N815 - WebRTC DataChannel API spelling
    bufferedAmount: int  # noqa: N815 - WebRTC DataChannel API spelling
    bufferedAmountLowThreshold: int  # noqa: N815 - WebRTC DataChannel API spelling

    def send(self, data: DataChannelPayload) -> None: ...


class DataChannelFlowError(RuntimeError):
    """Base class for DataChannel flow-control failures."""


class DataChannelClosedError(DataChannelFlowError):
    """Raised when the DataChannel is not open while sending or waiting."""


class DataChannelBackpressureTimeoutError(DataChannelFlowError):
    """Raised when buffered data does not drain before the configured timeout."""


class DataChannelQueueLimitExceededError(DataChannelFlowError):
    """Raised when the caller-provided payload batch exceeds local bounds."""


@dataclass(frozen=True)
class DataChannelFlowLimits:
    """Backpressure and batching limits for ordered DataChannel sends."""

    high_watermark_bytes: int = 1_048_576
    low_watermark_bytes: int = 262_144
    max_queue_messages: int = 512
    max_queue_bytes: int = 16_777_216
    poll_interval_seconds: float = 0.01
    drain_timeout_seconds: float = 10.0

    def __post_init__(self) -> None:
        if self.high_watermark_bytes <= 0:
            raise ValueError("high_watermark_bytes must be positive")
        if self.low_watermark_bytes < 0:
            raise ValueError("low_watermark_bytes must be non-negative")
        if self.low_watermark_bytes > self.high_watermark_bytes:
            raise ValueError("low_watermark_bytes must not exceed high_watermark_bytes")
        if self.max_queue_messages <= 0:
            raise ValueError("max_queue_messages must be positive")
        if self.max_queue_bytes <= 0:
            raise ValueError("max_queue_bytes must be positive")
        if self.poll_interval_seconds <= 0:
            raise ValueError("poll_interval_seconds must be positive")
        if self.drain_timeout_seconds <= 0:
            raise ValueError("drain_timeout_seconds must be positive")


class DataChannelFlowController:
    """Send ordered DataChannel payloads with bounded backpressure handling.

    A controller owns no background tasks.  Waiters are created only while an
    async send is suspended and are removed on completion, timeout, close, or
    cancellation.  Controllers are independent per channel, so a blocked peer
    cannot block sends on another peer's DataChannel.
    """

    def __init__(
        self,
        channel: DataChannelLike,
        *,
        limits: DataChannelFlowLimits | None = None,
    ) -> None:
        self._channel = channel
        self._limits = limits or DataChannelFlowLimits()
        self._waiters: set[asyncio.Future[None]] = set()
        self._registered_callbacks: list[tuple[str, Any]] = []
        self._closed = False
        self._configure_low_threshold()

    @property
    def limits(self) -> DataChannelFlowLimits:
        """Return immutable limits used by this controller."""

        return self._limits

    @property
    def pending_waiter_count(self) -> int:
        """Number of currently registered drain waiters, exposed for tests/diagnostics."""

        return len(self._waiters)

    async def send_many(self, payloads: Iterable[DataChannelPayload]) -> int:
        """Send payloads in input order while respecting channel backpressure.

        Args:
            payloads: Ordered iterable of ``str`` or ``bytes`` DataChannel frames.

        Returns:
            Number of payloads sent.

        Raises:
            TypeError: a payload is neither ``str`` nor ``bytes``.
            DataChannelQueueLimitExceededError: batch exceeds count/byte limits.
            DataChannelClosedError: channel is not open before/during sending.
            DataChannelBackpressureTimeoutError: drain threshold is not reached in time.
        """

        batch = tuple(payloads)
        self._validate_batch(batch)
        sent = 0
        for payload in batch:
            self._ensure_open()
            await self._wait_until_send_capacity(self._payload_size(payload))
            self._ensure_open()
            self._channel.send(payload)
            sent += 1
            if self._buffered_amount() >= self._limits.high_watermark_bytes:
                await self._wait_for_drain(self._limits.low_watermark_bytes)
        return sent

    def cleanup(self) -> None:
        """Remove listeners and wake any outstanding waiters.

        This is idempotent and safe to call from cancellation/finally blocks.
        """

        self._closed = True
        for event_name, callback in self._registered_callbacks:
            self._remove_listener(event_name, callback)
        self._registered_callbacks.clear()
        for waiter in tuple(self._waiters):
            if not waiter.done():
                waiter.cancel()
        self._waiters.clear()

    def _configure_low_threshold(self) -> None:
        with contextlib.suppress(AttributeError):
            self._channel.bufferedAmountLowThreshold = self._limits.low_watermark_bytes

    def _validate_batch(self, batch: tuple[DataChannelPayload, ...]) -> None:
        if len(batch) > self._limits.max_queue_messages:
            raise DataChannelQueueLimitExceededError(
                f"DataChannel send batch has {len(batch)} payloads; limit is "
                f"{self._limits.max_queue_messages}"
            )
        total = 0
        for payload in batch:
            total += self._payload_size(payload)
        if total > self._limits.max_queue_bytes:
            raise DataChannelQueueLimitExceededError(
                f"DataChannel send batch has {total} bytes; limit is {self._limits.max_queue_bytes}"
            )

    def _payload_size(self, payload: DataChannelPayload) -> int:
        if isinstance(payload, bytes):
            return len(payload)
        if isinstance(payload, str):
            return len(payload.encode("utf-8"))
        raise TypeError(f"DataChannel payload must be str or bytes, got {type(payload).__name__}")

    async def _wait_until_send_capacity(self, payload_size: int) -> None:
        if payload_size >= self._limits.high_watermark_bytes:
            target = self._limits.low_watermark_bytes
        else:
            target = max(0, self._limits.high_watermark_bytes - payload_size)
        if self._buffered_amount() > target:
            await self._wait_for_drain(target)

    async def _wait_for_drain(self, target_bytes: int) -> None:
        self._ensure_open()
        if self._buffered_amount() <= target_bytes:
            return

        loop = asyncio.get_running_loop()
        waiter: asyncio.Future[None] = loop.create_future()
        self._waiters.add(waiter)
        registered_events: list[tuple[str, Any]] = []

        def fail_closed() -> None:
            if not waiter.done():
                waiter.set_exception(DataChannelClosedError("DataChannel is not open"))

        def on_low() -> None:
            if waiter.done():
                return
            if not self._is_open():
                fail_closed()
                return
            if self._buffered_amount() <= target_bytes:
                waiter.set_result(None)

        try:
            if self._register_callback("close", fail_closed):
                registered_events.append(("close", fail_closed))
            if self._register_callback("bufferedamountlow", on_low):
                registered_events.append(("bufferedamountlow", on_low))
            else:
                await self._poll_for_drain(waiter, target_bytes)
                return
            on_low()
            await asyncio.wait_for(waiter, timeout=self._limits.drain_timeout_seconds)
            self._ensure_open()
        except TimeoutError as exc:
            raise DataChannelBackpressureTimeoutError(
                f"DataChannel bufferedAmount did not drain to {target_bytes} bytes "
                f"within {self._limits.drain_timeout_seconds:.3f}s"
            ) from exc
        finally:
            self._waiters.discard(waiter)
            for event_name, callback in registered_events:
                self._remove_listener(event_name, callback)
                with contextlib.suppress(ValueError):
                    self._registered_callbacks.remove((event_name, callback))

    async def _poll_for_drain(self, waiter: asyncio.Future[None], target_bytes: int) -> None:
        deadline = asyncio.get_running_loop().time() + self._limits.drain_timeout_seconds
        while self._buffered_amount() > target_bytes:
            self._ensure_open()
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise DataChannelBackpressureTimeoutError(
                    f"DataChannel bufferedAmount did not drain to {target_bytes} bytes "
                    f"within {self._limits.drain_timeout_seconds:.3f}s"
                )
            await asyncio.sleep(min(self._limits.poll_interval_seconds, remaining))
        if not waiter.done():
            waiter.set_result(None)

    def _register_callback(self, event_name: str, callback: Any) -> bool:
        on = getattr(self._channel, "on", None)
        if on is None:
            return False
        try:
            result = on(event_name, callback)
        except TypeError:
            try:
                decorator = on(event_name)
            except Exception:
                return False
            if not callable(decorator):
                return False
            decorator(callback)
            result = None
        except Exception:
            return False

        # ``aiortc`` returns the callback/decorator synchronously.  If a fake or
        # alternate emitter returns an awaitable, schedule no background task;
        # fail back to polling because registration did not complete now.
        if inspect.isawaitable(result):
            close = getattr(result, "close", None)
            if callable(close):
                close()
            return False
        self._registered_callbacks.append((event_name, callback))
        return True

    def _remove_listener(self, event_name: str, callback: Any) -> None:
        for remover_name in ("remove_listener", "off"):
            remover = getattr(self._channel, remover_name, None)
            if remover is None:
                continue
            try:
                remover(event_name, callback)
                return
            except Exception:
                continue
        remover = getattr(self._channel, "removeEventListener", None)
        if remover is not None:
            with contextlib.suppress(Exception):
                remover(event_name, callback)

    def _ensure_open(self) -> None:
        if self._closed or not self._is_open():
            raise DataChannelClosedError("DataChannel is not open")

    def _is_open(self) -> bool:
        return getattr(self._channel, "readyState", None) == "open"

    def _buffered_amount(self) -> int:
        return int(getattr(self._channel, "bufferedAmount", 0) or 0)


async def send_ordered_with_backpressure(
    channel: DataChannelLike,
    payloads: Iterable[DataChannelPayload],
    *,
    limits: DataChannelFlowLimits | None = None,
) -> int:
    """Convenience wrapper for one-shot ordered DataChannel sends."""

    controller = DataChannelFlowController(channel, limits=limits)
    try:
        return await controller.send_many(payloads)
    finally:
        controller.cleanup()
