"""Opt-in, content-free recorder for real Python speech lifecycle boundaries.

This module is deliberately not imported by Aurora services. A measurement
owner must explicitly construct a recorder and pass it through an existing
``lifecycle_observer`` seam, or wrap a known provider call with ``async_span``.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import threading
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Mapping

from app.shared.contracts.models.speech_runtime import SpeechLifecycleObservationV1

_HOST_ID = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$")
_SAFE_ID = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$")
_STAGES = frozenset({"stt", "llm", "tool", "tts", "playback", "render", "history"})
_SPAN_OUTCOMES = frozenset({"started", "completed", "canceled", "failed"})
_SPAN_REASONS = frozenset({"cancelled", "provider_failure"})
_MAX_EVENTS = 50_000
_MAX_BYTES = 64 * 1024 * 1024
_OBSERVATION_FIELDS = frozenset(
    {
        "event",
        "operation_id",
        "attempt_id",
        "generation",
        "stage",
        "monotonic_ns",
        "boot_id",
        "clock_domain",
        "route_revision",
        "config_revision",
        "outcome",
        "reason_code",
        "byte_count",
        "sample_count",
        "chunk_count",
        "dropped_count",
    }
)


class JsonlStageObserver:
    """Write only allowlisted lifecycle metadata to a fresh mode-0600 file.

    ``host_id_pseudonym`` must be supplied by the measurement owner. This
    recorder never derives a machine name, reads environment variables, or
    guesses provider identity from configured settings.
    """

    def __init__(self, path: Path, *, host_id_pseudonym: str) -> None:
        if not _HOST_ID.fullmatch(host_id_pseudonym):
            raise ValueError("host_id_pseudonym must be a short predeclared identifier")
        self.path = Path(path)
        self.host_id_pseudonym = host_id_pseudonym
        self.recorder_process_id = uuid.uuid4().hex
        self.receiver_pid = os.getpid()
        self._lock = threading.Lock()
        self._event_count = 0
        self._encoded_bytes = 0
        self._write_error_count = 0
        self._rejected_event_count = 0
        self._flush_error_count = 0
        self._closed = False
        self._fd = os.open(
            self.path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )

    def observe(
        self,
        observation: Any,
        *,
        harness_case_id: str | None = None,
        harness_stage_id: str | None = None,
    ) -> None:
        """Persist an existing ``SpeechLifecycleObservationV1`` only."""
        if not isinstance(observation, SpeechLifecycleObservationV1):
            self._note_rejected_event()
            raise TypeError("observation must be SpeechLifecycleObservationV1")
        try:
            source = observation.model_dump(mode="json")
            clean = {key: source[key] for key in _OBSERVATION_FIELDS if key in source}
        except Exception:
            self._note_rejected_event()
            raise
        # Existing observation contracts contain no request/session/trace IDs
        # or selected-provider binding. Keep those explicitly unknown.
        row = {
            "record_schema": "aurora.desktop-stage-observation.v2",
            "record_kind": "speech_lifecycle_observation",
            "host_id_pseudonym": self.host_id_pseudonym,
            "receiver_pid": self.receiver_pid,
            "recorder_process_id": self.recorder_process_id,
            "receiver_wall_time_ns": str(time.time_ns()),
            "receiver_monotonic_ns": str(time.monotonic_ns()),
            "event_clock_domain": clean.get("clock_domain", "python_process_monotonic"),
            "trace_id": None,
            "request_id": None,
            "session_id": None,
            "correlation_id": None,
            "span_id": None,
            "parent_span_id": None,
            "handler": None,
            "selected_provider": None,
            "harness_case_id": harness_case_id,
            "harness_stage_id": harness_stage_id,
            "observation": clean,
        }
        self._write(row)

    def record_span(
        self,
        *,
        event: str,
        stage: str,
        span_id: str,
        parent_span_id: str | None,
        handler: str | None,
        selected_provider: str | None,
        request_id: str | None = None,
        session_id: str | None = None,
        correlation_id: str | None = None,
        operation_id: str | None = None,
        attempt_id: str | None = None,
        harness_case_id: str | None = None,
        harness_stage_id: str | None = None,
        monotonic_ns: int,
        outcome: str | None = None,
        reason_code: str | None = None,
    ) -> None:
        """Record a caller-timed boundary around a real invocation.

        The caller must pass the handler/provider actually invoked. Null means
        the source did not expose that binding; configured values are not used.
        """
        if (
            not isinstance(stage, str)
            or stage not in _STAGES
            or not isinstance(event, str)
            or event not in {"span_start", "span_end"}
        ):
            self._note_rejected_event()
            raise ValueError("span stage or event is not in the fixed allowlist")
        if (
            not isinstance(outcome, str)
            or outcome not in _SPAN_OUTCOMES
            or reason_code is not None
            and (not isinstance(reason_code, str) or reason_code not in _SPAN_REASONS)
        ):
            self._note_rejected_event()
            raise ValueError("span outcome or reason is not in the fixed allowlist")
        if type(monotonic_ns) is not int or monotonic_ns < 0:
            self._note_rejected_event()
            raise ValueError("monotonic_ns must be a nonnegative integer")
        for field, value in (
            ("span_id", span_id),
            ("parent_span_id", parent_span_id),
            ("handler", handler),
            ("selected_provider", selected_provider),
            ("request_id", request_id),
            ("session_id", session_id),
            ("correlation_id", correlation_id),
            ("operation_id", operation_id),
            ("attempt_id", attempt_id),
            ("harness_case_id", harness_case_id),
            ("harness_stage_id", harness_stage_id),
        ):
            if value is not None and (not isinstance(value, str) or not _SAFE_ID.fullmatch(value)):
                self._note_rejected_event()
                raise ValueError(f"{field} is not a safe identifier")
        row = {
            "record_schema": "aurora.desktop-stage-observation.v2",
            "record_kind": "invocation_span_boundary",
            "host_id_pseudonym": self.host_id_pseudonym,
            "receiver_pid": self.receiver_pid,
            "recorder_process_id": self.recorder_process_id,
            "receiver_wall_time_ns": str(time.time_ns()),
            "clock_domain": "python_process_monotonic",
            "monotonic_ns": str(monotonic_ns),
            "trace_id": None,
            "request_id": request_id,
            "session_id": session_id,
            "correlation_id": correlation_id,
            "operation_id": operation_id,
            "attempt_id": attempt_id,
            "harness_case_id": harness_case_id,
            "harness_stage_id": harness_stage_id,
            "span_id": span_id,
            "parent_span_id": parent_span_id,
            "stage": stage,
            "event": event,
            "handler": handler,
            "selected_provider": selected_provider,
            "outcome": outcome,
            "reason_code": reason_code,
        }
        self._write(row)

    def _write(self, row: Mapping[str, Any]) -> None:
        encoded = (json.dumps(row, sort_keys=True, separators=(",", ":")) + "\n").encode(
            "utf-8"
        )
        with self._lock:
            if self._closed:
                self._write_error_count += 1
                raise RuntimeError("observer is closed")
            if (
                self._event_count >= _MAX_EVENTS
                or self._encoded_bytes + len(encoded) > _MAX_BYTES
            ):
                self._write_error_count += 1
                raise BufferError("observer capacity exceeded")
            try:
                written = os.write(self._fd, encoded)
                if written != len(encoded):
                    self._write_error_count += 1
                    raise OSError("short observer write")
            except OSError:
                self._write_error_count += 1
                raise
            self._event_count += 1
            self._encoded_bytes += len(encoded)

    def _note_rejected_event(self) -> None:
        with self._lock:
            self._rejected_event_count += 1

    def close(self) -> dict[str, int | bool]:
        """Flush and close without masking the caller's measured operation."""
        with self._lock:
            if not self._closed:
                try:
                    os.fsync(self._fd)
                except OSError:
                    self._flush_error_count += 1
                finally:
                    try:
                        os.close(self._fd)
                    except OSError:
                        self._flush_error_count += 1
                    self._closed = True
            return {
                "event_count": self._event_count,
                "encoded_bytes": self._encoded_bytes,
                "write_error_count": self._write_error_count,
                "rejected_event_count": self._rejected_event_count,
                "flush_error_count": self._flush_error_count,
                "capture_complete": not any(
                    (
                        self._write_error_count,
                        self._rejected_event_count,
                        self._flush_error_count,
                    )
                ),
            }


@asynccontextmanager
async def async_span(
    observer: JsonlStageObserver,
    *,
    stage: str,
    handler: str | None,
    selected_provider: str | None,
    request_id: str | None = None,
    session_id: str | None = None,
    correlation_id: str | None = None,
    operation_id: str | None = None,
    attempt_id: str | None = None,
    harness_case_id: str | None = None,
    harness_stage_id: str | None = None,
    parent_span_id: str | None = None,
) -> AsyncIterator[str]:
    """Time one real awaited call using its local monotonic clock domain."""
    span_id = uuid.uuid4().hex
    started_ns = time.monotonic_ns()
    try:
        observer.record_span(
            event="span_start",
            stage=stage,
            span_id=span_id,
            parent_span_id=parent_span_id,
            handler=handler,
            selected_provider=selected_provider,
            request_id=request_id,
            session_id=session_id,
            correlation_id=correlation_id,
            operation_id=operation_id,
            attempt_id=attempt_id,
            harness_case_id=harness_case_id,
            harness_stage_id=harness_stage_id,
            monotonic_ns=started_ns,
            outcome="started",
        )
    except Exception:
        # The observer is passive; a failed start record cannot block the call.
        pass
    outcome = "completed"
    reason_code = None
    try:
        yield span_id
    except asyncio.CancelledError:
        outcome = "canceled"
        reason_code = "cancelled"
        raise
    except Exception:
        outcome = "failed"
        reason_code = "provider_failure"
        raise
    finally:
        try:
            observer.record_span(
                event="span_end",
                stage=stage,
                span_id=span_id,
                parent_span_id=parent_span_id,
                handler=handler,
                selected_provider=selected_provider,
                request_id=request_id,
                session_id=session_id,
                correlation_id=correlation_id,
                operation_id=operation_id,
                attempt_id=attempt_id,
                harness_case_id=harness_case_id,
                harness_stage_id=harness_stage_id,
                monotonic_ns=time.monotonic_ns(),
                outcome=outcome,
                reason_code=reason_code,
            )
        except Exception:
            # Do not mask an invocation exception/cancellation with recorder IO.
            pass


__all__ = ["JsonlStageObserver", "async_span"]
