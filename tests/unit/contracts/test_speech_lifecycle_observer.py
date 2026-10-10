"""Bounded and payload-free speech lifecycle observer contracts."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.shared.contracts.models.speech_runtime import SpeechLifecycleObservationV1
from app.shared.speech_lifecycle_observer import (
    BoundedSpeechLifecycleTestSink,
    emit_speech_lifecycle,
)


def _event(event: str = "model_invoke_start") -> SpeechLifecycleObservationV1:
    return SpeechLifecycleObservationV1(
        event=event,
        operation_id="operation-1",
        attempt_id="attempt-1",
        generation=1,
        stage="stt",
        monotonic_ns="123456789",
        boot_id="0123456789abcdef0123456789abcdef",
        route_revision="route-7",
        config_revision=4,
        outcome="started",
        byte_count=64,
        dropped_count=0,
    )


def test_observation_contract_rejects_payload_fields_and_keeps_clock_exact() -> None:
    event = _event()

    assert event.monotonic_ns == "123456789"
    assert event.clock_domain == "python_process_monotonic"
    assert event.route_revision == "route-7"
    assert event.model_dump()["redacted"] is True
    assert not {"audio", "transcript", "prompt", "token", "path"}.intersection(event.model_dump())
    with pytest.raises(ValidationError):
        SpeechLifecycleObservationV1.model_validate(
            {**event.model_dump(), "transcript": "private words"}
        )
    native_event = SpeechLifecycleObservationV1.model_validate(
        {**event.model_dump(), "clock_domain": "native_process_start_monotonic"}
    )
    assert native_event.clock_domain == "native_process_start_monotonic"
    with pytest.raises(ValidationError):
        SpeechLifecycleObservationV1.model_validate(
            {**event.model_dump(), "reason_code": "private_error_text"}
        )


def test_bounded_sink_reserves_admission_and_terminal_capacity() -> None:
    sink = BoundedSpeechLifecycleTestSink()
    for _ in range(449):
        sink.observe(_event())

    sink.observe(_event("action_admitted"))
    events = sink.snapshot()

    assert len(events) == 449
    assert events[-1].event == "action_admitted"
    assert events[-1].dropped_count == 1
    assert sink.dropped_detail_count == 1
    assert sink.dropped_summary_count == 0


def test_disabled_and_failing_observers_do_not_change_the_call() -> None:
    emit_speech_lifecycle(
        None,
        event="terminal",
        operation_id="operation-1",
        attempt_id="attempt-1",
        stage="tts",
        outcome="completed",
    )

    def broken_observer(_event: SpeechLifecycleObservationV1) -> None:
        raise RuntimeError("observer failure")

    emit_speech_lifecycle(
        broken_observer,
        event="terminal",
        operation_id="operation-1",
        attempt_id="attempt-1",
        stage="tts",
        outcome="completed",
    )
