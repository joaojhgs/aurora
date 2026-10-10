"""Finite STT handler execution and audio-format regression tests."""

from __future__ import annotations

import asyncio
import base64
import io
import logging
import threading
import traceback
import wave
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, Mock, patch

import numpy as np
import pytest

from app.helpers.aurora_logger import logger as aurora_logger
from app.services.stt_transcription.service import TranscriptionService
from app.shared.contracts.models.speech_runtime import SpeechLifecycleObservationV1
from app.shared.contracts.models.stt import TranscribeAudioRequest
from app.shared.speech_lifecycle_observer import BoundedSpeechLifecycleTestSink


def _service_with_models() -> tuple[TranscriptionService, Mock, MagicMock, MagicMock]:
    bus = Mock()
    bus.publish = AsyncMock()
    realtime = MagicMock()
    accurate = MagicMock()
    segment = SimpleNamespace(text=" recognized words ")
    info = SimpleNamespace(language="fr")
    realtime.transcribe.return_value = ([segment], info)
    accurate.transcribe.return_value = ([segment], info)
    with patch("app.shared.services.base_service.get_bus_singleton", return_value=bus):
        service = TranscriptionService()
    service._bus = bus
    service._realtime_enabled = True
    service._accurate_enabled = True
    service._realtime_model = realtime
    service._accurate_model = accurate
    return service, bus, realtime, accurate


def _encoded_audio(audio_format: str) -> str:
    pcm = b"\x01\x00" * 16000
    if audio_format == "raw":
        payload = pcm
    else:
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(16000)
            wav_file.writeframes(pcm)
        payload = buffer.getvalue()
    return base64.b64encode(payload).decode("ascii")


@pytest.mark.parametrize("audio_format", ["raw", "wav"])
@pytest.mark.parametrize("model_name,beam_size", [("realtime", 1), ("accurate", 5)])
@pytest.mark.asyncio
async def test_finite_transcription_preserves_audio_and_model_controls(
    audio_format: str, model_name: str, beam_size: int
) -> None:
    service, _bus, realtime, accurate = _service_with_models()
    model = accurate if model_name == "accurate" else realtime
    request = TranscribeAudioRequest(
        audio_data=_encoded_audio(audio_format),
        format=audio_format,
        sample_rate=16000,
        channels=1,
        language="fr",
        model=model_name,
    )

    result = await service.transcribe_audio(request)

    assert result.text == "recognized words"
    assert result.language == "fr"
    assert result.model_used == model_name
    assert result.duration_ms == pytest.approx(1000.0)
    model.transcribe.assert_called_once()
    assert model.transcribe.call_args.kwargs == {
        "language": "fr",
        "beam_size": beam_size,
        "vad_filter": True,
    }
    (audio,) = model.transcribe.call_args.args
    assert isinstance(audio, np.ndarray)
    assert audio.dtype == np.float32
    assert audio.size == 16000


@pytest.mark.asyncio
async def test_finite_transcription_observer_tracks_real_model_boundary_without_audio() -> None:
    service, _bus, realtime, _accurate = _service_with_models()
    sink = BoundedSpeechLifecycleTestSink()
    consumed_segments: list[bool] = []
    model_end_observed_after_consumption: list[bool] = []

    def lazy_segments():
        yield SimpleNamespace(text=" recognized words ")
        consumed_segments.append(True)

    realtime.transcribe.return_value = (lazy_segments(), SimpleNamespace(language="fr"))

    class ObservingSink:
        def observe(self, event: SpeechLifecycleObservationV1) -> None:
            sink.observe(event)
            if event.event == "model_invoke_end":
                model_end_observed_after_consumption.append(bool(consumed_segments))

    service._speech_lifecycle_observer = ObservingSink()

    await service.transcribe_audio(
        TranscribeAudioRequest(
            audio_data=_encoded_audio("raw"),
            format="raw",
            sample_rate=16000,
            channels=1,
            model="realtime",
        )
    )

    events = sink.snapshot()
    assert [event.event for event in events] == [
        "action_admitted",
        "model_invoke_start",
        "model_invoke_end",
        "terminal",
    ]
    assert events[0].operation_id != events[0].attempt_id
    assert all(event.stage == "stt" for event in events)
    assert all(event.route_revision is None and event.config_revision is None for event in events)
    assert events[1].byte_count == 32_000
    assert "recognized words" not in str([event.model_dump() for event in events])
    assert model_end_observed_after_consumption == [True]


@pytest.mark.asyncio
async def test_finite_transcription_returns_text_without_logging_transcript(
    monkeypatch, caplog
) -> None:
    service, _bus, realtime, _accurate = _service_with_models()
    transcript = "private unlock phrase"
    realtime.transcribe.return_value = (
        [SimpleNamespace(text=transcript)],
        SimpleNamespace(language="en"),
    )
    monkeypatch.setattr(aurora_logger.logger, "propagate", True)
    caplog.set_level(logging.INFO, logger="Aurora")
    request = TranscribeAudioRequest(
        audio_data=_encoded_audio("raw"),
        format="raw",
        sample_rate=16000,
        channels=1,
        model="realtime",
    )

    result = await service.transcribe_audio(request)

    assert result.text == transcript
    assert caplog.records
    assert transcript not in caplog.text


@pytest.mark.asyncio
async def test_finite_transcription_failure_keeps_error_and_logs_private(
    monkeypatch, caplog
) -> None:
    service, _bus, realtime, _accurate = _service_with_models()
    private_failure = "decoder failed at /private/models/secret-voice.bin"
    realtime.transcribe.side_effect = RuntimeError(private_failure)
    monkeypatch.setattr(aurora_logger.logger, "propagate", True)
    caplog.set_level(logging.ERROR, logger="Aurora")
    request = TranscribeAudioRequest(
        audio_data=_encoded_audio("raw"),
        format="raw",
        sample_rate=16000,
        channels=1,
        model="realtime",
    )

    with pytest.raises(RuntimeError, match="^Transcription failed$") as exc_info:
        await service.transcribe_audio(request)

    assert caplog.records
    assert private_failure not in caplog.text
    assert all(record.exc_info is None for record in caplog.records)
    rendered_traceback = "".join(
        traceback.format_exception(exc_info.type, exc_info.value, exc_info.tb)
    )
    assert private_failure not in rendered_traceback


@pytest.mark.parametrize("failure_stage", ["model_call", "segment_iteration"])
@pytest.mark.asyncio
async def test_engine_value_error_cannot_spoof_invalid_audio_sanitization(
    failure_stage: str, monkeypatch, caplog
) -> None:
    service, _bus, realtime, _accurate = _service_with_models()
    private_failure = "Invalid base64 audio data: /private/models/secret.bin"
    if failure_stage == "model_call":
        realtime.transcribe.side_effect = ValueError(private_failure)
    else:

        def failing_segments():
            yield SimpleNamespace(text="partial private result")
            raise ValueError(private_failure)

        realtime.transcribe.return_value = (
            failing_segments(),
            SimpleNamespace(language="en"),
        )
    monkeypatch.setattr(aurora_logger.logger, "propagate", True)
    caplog.set_level(logging.ERROR, logger="Aurora")
    request = TranscribeAudioRequest(
        audio_data=_encoded_audio("raw"),
        format="raw",
        sample_rate=16000,
        channels=1,
        model="realtime",
    )

    with pytest.raises(RuntimeError, match="^Transcription failed$") as exc_info:
        await service.transcribe_audio(request)

    assert caplog.records
    assert private_failure not in caplog.text
    assert all(record.exc_info is None for record in caplog.records)
    rendered_traceback = "".join(
        traceback.format_exception(exc_info.type, exc_info.value, exc_info.tb)
    )
    assert private_failure not in rendered_traceback


@pytest.mark.asyncio
async def test_invalid_base64_audio_preserves_its_safe_error_prefix() -> None:
    service, _bus, realtime, accurate = _service_with_models()
    request = TranscribeAudioRequest(
        audio_data="a",
        format="raw",
        sample_rate=16000,
        channels=1,
        model="realtime",
    )

    with pytest.raises(ValueError, match="^Invalid base64 audio data:"):
        await service.transcribe_audio(request)

    realtime.transcribe.assert_not_called()
    accurate.transcribe.assert_not_called()


@pytest.mark.parametrize("blocked_stage", ["audio_decode", "model_call", "segment_iteration"])
@pytest.mark.asyncio
async def test_finite_transcription_keeps_event_loop_running_during_model_work(
    blocked_stage: str, monkeypatch
) -> None:
    service, _bus, _realtime, _accurate = _service_with_models()
    model = MagicMock()
    service._realtime_model = model
    entered_engine = threading.Event()
    release_engine = threading.Event()
    released_by_async_task = threading.Event()
    worker_observed_async_release: list[bool] = []
    info = SimpleNamespace(language="en")

    def block_engine() -> None:
        entered_engine.set()
        release_engine.wait(timeout=3.0)
        worker_observed_async_release.append(released_by_async_task.is_set())

    def transcribe(*_args, **_kwargs):
        if blocked_stage == "model_call":
            block_engine()

        def segments():
            if blocked_stage == "segment_iteration":
                block_engine()
            yield SimpleNamespace(text="ready")

        return segments(), info

    model.transcribe.side_effect = transcribe
    if blocked_stage == "audio_decode":
        original_decode_audio = service._decode_audio_to_numpy

        def decode_audio(*_args, **_kwargs):
            block_engine()
            return original_decode_audio(*_args, **_kwargs)

        monkeypatch.setattr(service, "_decode_audio_to_numpy", decode_audio)
    request = TranscribeAudioRequest(
        audio_data=base64.b64encode(b"\x00\x00" * 16000).decode("ascii"),
        format="raw",
        sample_rate=16000,
        channels=1,
        model="realtime",
    )

    async def release_after_engine_entry() -> None:
        assert await asyncio.to_thread(entered_engine.wait, 2.0), (
            "finite inference never entered the expected blocking boundary"
        )
        released_by_async_task.set()
        release_engine.set()

    release_task = asyncio.create_task(release_after_engine_entry())
    fallback_release = threading.Timer(1.0, release_engine.set)
    fallback_release.start()
    transcription_task = asyncio.create_task(service.transcribe_audio(request))
    try:
        result = await asyncio.wait_for(transcription_task, timeout=4.0)
    finally:
        release_engine.set()
        fallback_release.cancel()
        if not transcription_task.done():
            transcription_task.cancel()
        if not release_task.done():
            release_task.cancel()
        await asyncio.gather(transcription_task, release_task, return_exceptions=True)

    assert result.text == "ready"
    assert model.transcribe.call_count == 1
    assert worker_observed_async_release == [True], (
        "the event-loop task could not release model work before its fallback timeout"
    )


@pytest.mark.parametrize(
    ("retirement", "model_name"),
    [
        ("replace", "realtime"),
        ("replace", "accurate"),
        ("disable", "realtime"),
        ("disable", "accurate"),
        ("deactivate", "realtime"),
    ],
)
@pytest.mark.asyncio
async def test_finite_transcription_rejects_results_from_retired_model_state(
    retirement: str, model_name: str
) -> None:
    service, _bus, realtime, accurate = _service_with_models()
    selected_model = accurate if model_name == "accurate" else realtime
    engine_entered = threading.Event()
    release_engine = threading.Event()

    def transcribe(*_args, **_kwargs):
        engine_entered.set()
        release_engine.wait(timeout=3.0)
        return [SimpleNamespace(text="retired transcript")], SimpleNamespace(language="en")

    selected_model.transcribe.side_effect = transcribe
    request = TranscribeAudioRequest(
        audio_data=_encoded_audio("raw"),
        format="raw",
        sample_rate=16000,
        channels=1,
        model=model_name,
    )
    task = asyncio.create_task(service.transcribe_audio(request))

    try:
        assert await asyncio.to_thread(engine_entered.wait, 2.0), (
            "finite inference did not enter the controlled model call"
        )
        if retirement == "replace":
            if model_name == "accurate":
                service._accurate_model = MagicMock()
            else:
                service._realtime_model = MagicMock()
        elif retirement == "disable":
            if model_name == "accurate":
                service._accurate_enabled = False
            else:
                service._realtime_enabled = False
        else:
            service._runtime_state = "active"
            service._started = True
            service._publish_service_departure = AsyncMock()
            service._unsubscribe_registered_contracts = Mock()
            service._subscribe_registered_contracts = AsyncMock()
            await service.deactivate(reason="test_retirement")

        release_engine.set()
        with pytest.raises(RuntimeError, match="^Transcription failed$"):
            await task
    finally:
        release_engine.set()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.parametrize(
    ("retirement", "model_name"),
    [
        ("replace", "realtime"),
        ("replace", "accurate"),
        ("disable", "realtime"),
        ("disable", "accurate"),
        ("deactivate", "realtime"),
    ],
)
@pytest.mark.asyncio
async def test_finite_transcription_skips_model_retired_during_audio_decode(
    retirement: str, model_name: str, monkeypatch
) -> None:
    service, _bus, realtime, accurate = _service_with_models()
    selected_model = accurate if model_name == "accurate" else realtime
    decoder_entered = threading.Event()
    release_decoder = threading.Event()
    decoder_finished = threading.Event()
    original_decode_audio = service._decode_audio_to_numpy

    def decode_audio(*args, **kwargs):
        decoder_entered.set()
        try:
            release_decoder.wait(timeout=3.0)
            return original_decode_audio(*args, **kwargs)
        finally:
            decoder_finished.set()

    monkeypatch.setattr(service, "_decode_audio_to_numpy", decode_audio)
    request = TranscribeAudioRequest(
        audio_data=_encoded_audio("raw"),
        format="raw",
        sample_rate=16000,
        channels=1,
        model=model_name,
    )
    task = asyncio.create_task(service.transcribe_audio(request))

    try:
        assert await asyncio.to_thread(decoder_entered.wait, 2.0), (
            "finite request did not enter the controlled decoder"
        )
        if retirement == "replace":
            if model_name == "accurate":
                service._accurate_model = MagicMock()
            else:
                service._realtime_model = MagicMock()
        elif retirement == "disable":
            if model_name == "accurate":
                service._accurate_enabled = False
            else:
                service._realtime_enabled = False
        else:
            service._runtime_state = "active"
            service._started = True
            service._publish_service_departure = AsyncMock()
            service._unsubscribe_registered_contracts = Mock()
            service._subscribe_registered_contracts = AsyncMock()
            await service.deactivate(reason="test_retirement_before_inference")

        release_decoder.set()
        with pytest.raises(RuntimeError, match="^Transcription failed$"):
            await task
        selected_model.transcribe.assert_not_called()
    finally:
        release_decoder.set()
        await asyncio.to_thread(decoder_finished.wait, 2.0)
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_finite_transcription_uses_request_snapshot_after_async_boundary(monkeypatch) -> None:
    service, _bus, realtime, accurate = _service_with_models()
    realtime.transcribe.return_value = (
        [SimpleNamespace(text=" original request result ")],
        SimpleNamespace(language="fr"),
    )
    decoder_entered = threading.Event()
    release_decoder = threading.Event()
    original_decode_audio = service._decode_audio_to_numpy

    def decode_audio(*args, **kwargs):
        decoder_entered.set()
        release_decoder.wait(timeout=3.0)
        return original_decode_audio(*args, **kwargs)

    monkeypatch.setattr(service, "_decode_audio_to_numpy", decode_audio)
    request = TranscribeAudioRequest(
        audio_data=_encoded_audio("raw"),
        format="raw",
        sample_rate=16000,
        channels=1,
        language="fr",
        model="realtime",
    )
    task = asyncio.create_task(service.transcribe_audio(request))

    try:
        assert await asyncio.to_thread(decoder_entered.wait, 2.0), (
            "finite request did not enter the controlled decoder"
        )
        request.model = "accurate"
        request.language = "de"
        request.sample_rate = 8000
        release_decoder.set()

        result = await task
        assert result.text == "original request result"
        assert result.model_used == "realtime"
        assert result.duration_ms == pytest.approx(1000.0)
        assert realtime.transcribe.call_args.kwargs == {
            "language": "fr",
            "beam_size": 1,
            "vad_filter": True,
        }
        accurate.transcribe.assert_not_called()
    finally:
        release_decoder.set()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_finite_transcription_rechecks_model_after_waiting_for_existing_lock() -> None:
    service, _bus, realtime, _accurate = _service_with_models()
    model_lock = threading.Lock()
    lock_waiting = threading.Event()
    model_lock.acquire()

    class ObservedModelLock:
        def __enter__(self):
            lock_waiting.set()
            model_lock.acquire()
            return self

        def __exit__(self, *_args):
            model_lock.release()

    service._model_lock = ObservedModelLock()
    request = TranscribeAudioRequest(
        audio_data=_encoded_audio("raw"),
        format="raw",
        sample_rate=16000,
        channels=1,
        model="realtime",
    )
    task = asyncio.create_task(service.transcribe_audio(request))

    try:
        assert await asyncio.to_thread(lock_waiting.wait, 2.0), (
            "finite request did not reach the existing model lock"
        )
        service._realtime_model = MagicMock()
        model_lock.release()
        with pytest.raises(RuntimeError, match="^Transcription failed$"):
            await task
        realtime.transcribe.assert_not_called()
    finally:
        if model_lock.locked():
            model_lock.release()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.parametrize("blocked_stage", ["audio_decode", "model_lock"])
@pytest.mark.asyncio
async def test_finite_cancellation_before_inference_never_calls_engine(blocked_stage: str) -> None:
    service, _bus, realtime, _accurate = _service_with_models()
    decoder_entered = threading.Event()
    release_decoder = threading.Event()
    lock_waiting = threading.Event()
    worker_left_lock = threading.Event()
    model_lock = threading.Lock()

    class ObservedModelLock:
        def __enter__(self):
            lock_waiting.set()
            model_lock.acquire()
            return self

        def __exit__(self, *_args):
            model_lock.release()
            worker_left_lock.set()

    service._model_lock = ObservedModelLock()
    if blocked_stage == "model_lock":
        model_lock.acquire()
    else:
        original_decode_audio = service._decode_audio_to_numpy

        def decode_audio(*args, **kwargs):
            decoder_entered.set()
            try:
                release_decoder.wait(timeout=3.0)
                return original_decode_audio(*args, **kwargs)
            finally:
                decoder_entered.set()

        service._decode_audio_to_numpy = decode_audio

    request = TranscribeAudioRequest(
        audio_data=_encoded_audio("raw"),
        format="raw",
        sample_rate=16000,
        channels=1,
        model="realtime",
    )
    task = asyncio.create_task(service.transcribe_audio(request))

    try:
        blocked_event = lock_waiting if blocked_stage == "model_lock" else decoder_entered
        assert await asyncio.to_thread(blocked_event.wait, 2.0), (
            f"finite worker did not reach the controlled {blocked_stage} boundary"
        )
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    finally:
        release_decoder.set()
        if blocked_stage == "model_lock" and model_lock.locked():
            model_lock.release()
        assert await asyncio.to_thread(worker_left_lock.wait, 2.0), (
            "cancelled finite worker did not leave the model lock"
        )
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    realtime.transcribe.assert_not_called()


@pytest.mark.asyncio
async def test_finite_transcription_cancellation_propagates_and_drains_worker() -> None:
    service, _bus, realtime, _accurate = _service_with_models()
    engine_entered = threading.Event()
    release_engine = threading.Event()
    worker_finished = threading.Event()

    def transcribe(*_args, **_kwargs):
        engine_entered.set()
        try:
            release_engine.wait(timeout=3.0)
            return [SimpleNamespace(text="cancelled transcript")], SimpleNamespace(language="en")
        finally:
            worker_finished.set()

    realtime.transcribe.side_effect = transcribe
    request = TranscribeAudioRequest(
        audio_data=_encoded_audio("raw"),
        format="raw",
        sample_rate=16000,
        channels=1,
        model="realtime",
    )
    task = asyncio.create_task(service.transcribe_audio(request))

    try:
        assert await asyncio.to_thread(engine_entered.wait, 2.0), (
            "finite inference did not enter the controlled model call"
        )
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert not worker_finished.is_set(), "the controlled worker should still be blocked"
    finally:
        release_engine.set()
        await asyncio.to_thread(worker_finished.wait, 2.0)
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    assert worker_finished.is_set()
