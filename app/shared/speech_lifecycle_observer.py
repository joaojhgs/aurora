"""Optional bounded, payload-free observation for speech lifecycle boundaries."""

from __future__ import annotations

import threading
import time
import uuid
from collections.abc import Callable
from typing import Protocol

from app.shared.contracts.models.speech_runtime import SpeechLifecycleObservationV1

_PROCESS_BOOT_ID = uuid.uuid4().hex
_MAX_EVENTS = 512
_MAX_BYTES = 256 * 1024
_DETAIL_EVENT_LIMIT = 448
_DETAIL_BYTE_LIMIT = 192 * 1024
_SUMMARY_EVENTS = frozenset(
    {
        "action_admitted",
        "admission_started",
        "admission_ended",
        "finish_requested",
        "cancel_requested",
        "terminal",
    }
)


class SpeechLifecycleObserver(Protocol):
    """Synchronous observer contract; callbacks must not control speech work."""

    def observe(self, event: SpeechLifecycleObservationV1) -> None:
        """Receive one already-redacted event."""


class BoundedSpeechLifecycleTestSink:
    """In-memory sink for tests with reserved room for admission/terminal summaries."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._events: list[SpeechLifecycleObservationV1] = []
        self._encoded_bytes = 0
        self._detail_events = 0
        self._detail_bytes = 0
        self._dropped_details = 0
        self._dropped_summaries = 0

    def observe(self, event: SpeechLifecycleObservationV1) -> None:
        """Store an event while enforcing both event and encoded-byte limits."""
        summary = event.event in _SUMMARY_EVENTS
        with self._lock:
            stored = event.model_copy(update={"dropped_count": self._dropped_details})
            encoded_size = len(stored.model_dump_json().encode("utf-8"))
            over_total = (
                len(self._events) >= _MAX_EVENTS or self._encoded_bytes + encoded_size > _MAX_BYTES
            )
            over_detail = (
                self._detail_events >= _DETAIL_EVENT_LIMIT
                or self._detail_bytes + encoded_size > _DETAIL_BYTE_LIMIT
            )
            if over_total or (not summary and over_detail):
                if summary:
                    self._dropped_summaries += 1
                else:
                    self._dropped_details += 1
                return
            self._events.append(stored)
            self._encoded_bytes += encoded_size
            if not summary:
                self._detail_events += 1
                self._detail_bytes += encoded_size

    def snapshot(self) -> tuple[SpeechLifecycleObservationV1, ...]:
        """Return an immutable copy of currently retained observations."""
        with self._lock:
            return tuple(self._events)

    @property
    def dropped_detail_count(self) -> int:
        with self._lock:
            return self._dropped_details

    @property
    def dropped_summary_count(self) -> int:
        with self._lock:
            return self._dropped_summaries


def emit_speech_lifecycle(
    observer: SpeechLifecycleObserver | Callable[[SpeechLifecycleObservationV1], None] | None,
    *,
    event: str,
    operation_id: str,
    attempt_id: str,
    stage: str,
    outcome: str,
    reason_code: str | None = None,
    generation: int | None = None,
    route_revision: str | None = None,
    config_revision: int | None = None,
    byte_count: int | None = None,
    sample_count: int | None = None,
    chunk_count: int | None = None,
) -> None:
    """Build and deliver an event only when observation is explicitly enabled.

    Invalid metadata and observer callback failures are isolated from the
    speech operation. No timestamp or DTO is allocated for the disabled path.
    """
    if observer is None:
        return
    try:
        observation = SpeechLifecycleObservationV1(
            event=event,
            operation_id=operation_id,
            attempt_id=attempt_id,
            generation=generation,
            stage=stage,
            monotonic_ns=str(time.monotonic_ns()),
            boot_id=_PROCESS_BOOT_ID,
            route_revision=route_revision,
            config_revision=config_revision,
            outcome=outcome,
            reason_code=reason_code,
            byte_count=byte_count,
            sample_count=sample_count,
            chunk_count=chunk_count,
        )
        observe = getattr(observer, "observe", None)
        if callable(observe):
            observe(observation)
        elif callable(observer):
            observer(observation)
    except Exception:
        # Observation is passive: malformed metadata and consumer failures do
        # not alter admission, inference, transcription, or playback.
        return


__all__ = [
    "BoundedSpeechLifecycleTestSink",
    "SpeechLifecycleObserver",
    "emit_speech_lifecycle",
]
