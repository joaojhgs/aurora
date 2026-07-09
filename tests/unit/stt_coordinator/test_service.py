"""Unit tests for the STTCoordinatorService."""

import asyncio
import contextlib
from unittest.mock import AsyncMock, MagicMock, call, patch

import pytest

from app.messaging import (
    Envelope,
    MessageBus,
    TranscriptionControl,
    TranscriptionResult,
    TranscriptionType,
)
from app.services.stt_coordinator.service import STTCoordinatorService, merge_transcript_text
from app.services.stt_wakeword.messages import WakeWordBackendType, WakeWordDetected
from app.shared.config.models import AmbientTranscription, AudioInput, Coordinator
from app.shared.contracts.models.common import EmptyInput
from app.shared.contracts.models.stt import (
    STTCoordinatorControl,
    STTMethods,
    TranscriptionMethods,
    WakeWordMethods,
)
from app.shared.contracts.models.tts import TTSMethods
from app.shared.messaging.models.stt_coordinator_models import STTState

# Topic aliases for backwards compatibility
WakeWordTopics = WakeWordMethods
TranscriptionTopics = TranscriptionMethods
STTCoordinatorTopics = STTMethods


class Any:
    def __eq__(self, other):
        return True


ANY = Any()


_MOCK_COORDINATOR = Coordinator(
    session_timeout_s=5.0,
    multi_turn_enabled=False,
    pause_tts_on_listen=True,
    ambient_transcription=AmbientTranscription(enable=False),
    audio_input=AudioInput(
        sample_rate=16000,
        channels=1,
        chunk_size=1024,
        device_index=None,
    ),
)


# Mock config_manager before it's imported by the service
@pytest.fixture(autouse=True)
def mock_config_manager():
    with patch("app.services.stt_coordinator.service.config_api") as mock_config:

        async def mock_aget_coord(key, *args, **kwargs):
            if args and args[0] is Coordinator:
                return _MOCK_COORDINATOR
            return False

        mock_config.aget = AsyncMock(side_effect=mock_aget_coord)
        yield mock_config


@pytest.fixture
def mock_bus():
    """Fixture for a mocked MessageBus."""
    bus = MagicMock(spec=MessageBus)
    bus.subscribe = MagicMock()
    bus.publish = AsyncMock()
    bus.request = AsyncMock(return_value=MagicMock(ok=False, error="not flushed"))
    bus.start = AsyncMock()
    bus.stop = AsyncMock()
    return bus


@pytest.fixture
def service(mock_bus):
    """Fixture for the STTCoordinatorService."""
    # Service uses bus singleton and PyAudio - patch both
    with (
        patch("app.shared.services.base_service.get_bus_singleton", return_value=mock_bus),
        patch("app.services.stt_coordinator.service.pyaudio") as mock_pyaudio,
    ):
        # Mock PyAudio to avoid hardware dependency
        mock_pa = MagicMock()
        mock_pyaudio.PyAudio.return_value = mock_pa
        mock_pyaudio.paInt16 = 8
        mock_stream = MagicMock()
        mock_stream.is_active.return_value = False
        mock_stream.is_stopped.return_value = True
        mock_pa.open.return_value = mock_stream
        mock_pa.get_default_input_device_info.return_value = {"index": 0, "name": "Mock Mic"}

        svc = STTCoordinatorService()
        yield svc


@pytest.mark.asyncio
async def test_service_initialization(service, mock_bus):
    """Test that the service initializes correctly."""
    # Service uses bus singleton - check via property
    assert service.bus is mock_bus
    assert service._state == STTState.IDLE
    assert not service._running


@pytest.mark.asyncio
async def test_start_service(service, mock_bus):
    """Test the start method of the service."""
    await service.start()
    assert service._running

    # Service uses auto-subscription via contracts now
    # These tests need to be updated to test contract-based subscriptions
    # Service uses auto-subscription via contracts - assertion removed

    # Check initial state transition
    assert service._state == STTState.IDLE
    mock_bus.publish.assert_any_call(
        TranscriptionTopics.CONTROL, TranscriptionControl(action="pause"), event=False
    )


@pytest.mark.asyncio
async def test_start_service_idempotent(service):
    """Test that starting the service multiple times has no adverse effect."""
    await service.start()
    assert service._running

    # Starting again should be idempotent - no error and still running
    await service.start()
    assert service._running


@pytest.mark.asyncio
async def test_stop_service(service):
    """Test the stop method of the service."""
    await service.start()

    # Create a mock timeout task
    service._timeout_task = asyncio.create_task(asyncio.sleep(1))

    await service.stop()
    assert not service._running
    assert service._timeout_task.cancelled()

    # Cleanup
    with contextlib.suppress(asyncio.CancelledError):
        await service._timeout_task


@pytest.mark.asyncio
async def test_on_wake_word_detected_starts_session(service, mock_bus):
    """Test that a wake word detection starts a new session when IDLE."""
    await service.start()

    wake_word_event = WakeWordDetected(
        wake_word="test_word",
        confidence=0.9,
        source="test_source",
        stream_id="test_stream",
        backend=WakeWordBackendType.OPENWAKEWORD,
    )
    envelope = Envelope(payload=wake_word_event, type=WakeWordTopics.DETECTED)

    await service._on_wake_word_detected(envelope)

    assert service._state == STTState.LISTENING
    assert service._current_session_id is not None

    # Check that session started event was published
    mock_bus.publish.assert_any_call(
        STTMethods.SESSION_STARTED,
        ANY,
        event=True,
        mesh=True,
        origin="internal",
    )

    # Check that transcription is resumed
    mock_bus.publish.assert_any_call(
        TranscriptionTopics.CONTROL, TranscriptionControl(action="resume"), event=False
    )

    # Cleanup timeout task
    if service._timeout_task and not service._timeout_task.done():
        service._timeout_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await service._timeout_task


@pytest.mark.asyncio
async def test_on_wake_word_ignored_when_not_idle(service):
    """Test that wake word is ignored if the service is not in IDLE state."""
    await service.start()

    # Manually set state to LISTENING
    await service._transition_to(STTState.LISTENING)

    wake_word_event = WakeWordDetected(
        wake_word="test_word",
        confidence=0.9,
        source="test_source",
        stream_id="test_stream",
        backend=WakeWordBackendType.OPENWAKEWORD,
    )
    envelope = Envelope(payload=wake_word_event, type=WakeWordTopics.DETECTED)

    with patch("app.services.stt_coordinator.service.log_debug") as mock_log_debug:
        await service._on_wake_word_detected(envelope)
        mock_log_debug.assert_called_with("Ignoring wake word (state: listening)")

    # State should not change, and no new session started
    assert service._state == STTState.LISTENING
    assert service._current_session_id is None


@pytest.mark.asyncio
async def test_on_wake_word_interrupts_tts_and_starts_session(service, mock_bus):
    """Wakeword should support barge-in by stopping TTS and starting a fresh session."""
    await service.start()

    await service._on_tts_lifecycle_event(Envelope(payload={}, type=TTSMethods.STARTED))
    wake_word_event = WakeWordDetected(
        wake_word="jarvis",
        confidence=0.9,
        source="test_source",
        stream_id="test_stream",
        backend=WakeWordBackendType.OPENWAKEWORD,
    )

    await service._on_wake_word_detected(
        Envelope(payload=wake_word_event, type=WakeWordTopics.DETECTED)
    )

    assert service._state == STTState.LISTENING
    assert service._current_session_id is not None
    assert service._tts_interrupted_for_session
    mock_bus.request.assert_any_call(
        TTSMethods.STOP,
        EmptyInput(),
        timeout=2.0,
        priority=ANY,
    )
    session_started_calls = [
        c for c in mock_bus.publish.call_args_list if c.args[0] == STTMethods.SESSION_STARTED
    ]
    assert session_started_calls

    transcription_result = TranscriptionResult(
        text="new request",
        transcription_type=TranscriptionType.ACCURATE,
        source="test_source",
        stream_id="test_stream",
        model="test_model",
        duration_ms=1000,
    )
    await service._on_transcription_result(
        Envelope(payload=transcription_result, type=TranscriptionTopics.RESULT)
    )
    tts_resume_calls = [
        c for c in mock_bus.publish.call_args_list if c.args[0] == TTSMethods.RESUME
    ]
    assert tts_resume_calls == []

    if service._timeout_task and not service._timeout_task.done():
        service._timeout_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await service._timeout_task


@pytest.mark.asyncio
async def test_transcription_result_ends_session(service, mock_bus):
    """Test that a transcription result ends the session (single-turn)."""
    await service.start()

    # Start a session manually
    await service._start_session("manual_start")

    transcription_result = TranscriptionResult(
        text="hello world",
        transcription_type=TranscriptionType.ACCURATE,
        source="test_source",
        stream_id="test_stream",
        model="test_model",
        duration_ms=1000,
    )
    envelope = Envelope(payload=transcription_result, type=TranscriptionTopics.RESULT)

    await service._on_transcription_result(envelope)

    # Give async operations time to complete
    await asyncio.sleep(0.05)

    # State should be IDLE after processing
    assert service._state == STTState.IDLE

    # Check that user speech captured event was published
    mock_bus.publish.assert_any_call(
        STTCoordinatorTopics.USER_SPEECH_CAPTURED,
        ANY,
        event=True,
        mesh=True,
        origin="internal",
    )

    # Check that session ended event was published
    mock_bus.publish.assert_any_call(
        STTMethods.SESSION_ENDED,
        ANY,
        event=True,
        mesh=True,
        origin="internal",
    )

    # Check that transcription is paused
    mock_bus.publish.assert_any_call(
        TranscriptionTopics.CONTROL, TranscriptionControl(action="pause"), event=False
    )


@pytest.mark.asyncio
async def test_session_timeout(service, mock_bus):
    """Test the session timeout functionality."""

    await service.start()
    # Use a very short timeout after config load so the test does not wait for
    # the configured production timeout.
    service._listen_timeout_seconds = 0.05

    # Manually set state and call timeout handler
    service._current_session_id = "test-session"
    service._state = STTState.LISTENING

    # Call timeout handler directly
    await service._timeout_handler()

    # Give time for async operations to complete
    await asyncio.sleep(0.05)

    # Check timeout statistics
    assert service._sessions_timeout == 1

    # The timeout path attempts to flush speech before ending. The default
    # mocked flush fails, so it falls back to ending the session as timeout.
    mock_bus.request.assert_awaited()
    assert service._state == STTState.IDLE

    # Check that session ended event was published with timeout reason
    session_ended_calls = [
        c
        for c in mock_bus.publish.call_args_list
        if c.args[0] == STTCoordinatorTopics.SESSION_ENDED
    ]
    assert len(session_ended_calls) > 0, "Session ended event should be published"


@pytest.mark.asyncio
async def test_session_timeout_flushes_pending_transcription_before_ending(service, mock_bus):
    """Timeout should flush speech so long utterances can still produce final responses."""
    await service.start()
    service._listen_timeout_seconds = 0.05
    service._current_session_id = "test-session"
    service._state = STTState.LISTENING
    mock_bus.request = AsyncMock(return_value=MagicMock(ok=True))

    await service._timeout_handler()
    await asyncio.sleep(0)

    assert service._state == STTState.PROCESSING
    mock_bus.request.assert_awaited_with(
        TranscriptionTopics.CONTROL,
        TranscriptionControl(action="flush"),
        timeout=12.0,
        priority=ANY,
    )

    if service._timeout_task and not service._timeout_task.done():
        service._timeout_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await service._timeout_task


@pytest.mark.asyncio
async def test_realtime_partial_refreshes_listening_timeout(service, mock_bus):
    """Realtime STT activity should extend the active listening session."""
    await service.start()
    await service._start_session("manual_start")
    first_timeout_task = service._timeout_task

    realtime_result = TranscriptionResult(
        text="still speaking",
        transcription_type=TranscriptionType.REALTIME,
        source="test_source",
        stream_id="test_stream",
        model="test_model",
        duration_ms=250,
    )
    envelope = Envelope(payload=realtime_result, type=TranscriptionTopics.RESULT)

    await service._on_transcription_result(envelope)
    await asyncio.sleep(0)

    assert service._state == STTState.LISTENING
    assert service._timeout_task is not None
    assert service._timeout_task is not first_timeout_task

    partial_calls = [c for c in mock_bus.publish.call_args_list if c.args[0] == STTMethods.PARTIAL]
    assert partial_calls, "Realtime transcription should be published for UI updates"

    # Cleanup timeout tasks created by the session and refresh.
    for task in {first_timeout_task, service._timeout_task}:
        if task and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


def test_merge_transcript_text_preserves_prefix_for_rolling_long_form_updates():
    """Rolling realtime/final STT tails should not overwrite prompt beginnings."""
    preview = ""
    for text in [
        "how much is 3 plus 5 plus 6?",
        "How much is 3 plus 5 plus 6 and search for me?",
        "how much is 3 plus 5 plus 6 and search for me the FGIPT latest news.",
        "and search for me the ad-gift latest news.",
    ]:
        preview = merge_transcript_text(preview, text, append_on_miss=False)

    assert preview == "how much is 3 plus 5 plus 6 and search for me the ad-gift latest news."


@pytest.mark.asyncio
async def test_long_form_realtime_tail_is_merged_into_final_transcription(service, mock_bus):
    """Coordinator should send the full merged prompt to orchestrator, not the final tail."""
    await service.start()
    await service._start_session("jarvis", session_id="long-session")

    partials = [
        "search for me the latest news about Brazil",
        "search for me the latest news about Brazil and Egypt",
        "Brazil and Egypt, and what kind of love is really good",
    ]
    for partial in partials:
        await service._on_transcription_result(
            Envelope(
                payload=TranscriptionResult(
                    text=partial,
                    transcription_type=TranscriptionType.REALTIME,
                    source="test_source",
                    stream_id="test_stream",
                    model="test_model",
                    duration_ms=250,
                ),
                type=TranscriptionTopics.RESULT,
            )
        )

    await service._on_transcription_result(
        Envelope(
            payload=TranscriptionResult(
                text="Egypt, and what kind of love is really good for the soul.",
                transcription_type=TranscriptionType.ACCURATE,
                source="test_source",
                stream_id="test_stream",
                model="test_model",
                duration_ms=5_000,
            ),
            type=TranscriptionTopics.RESULT,
        )
    )

    final_calls = [
        c for c in mock_bus.publish.call_args_list if c.args[0] == STTMethods.USER_SPEECH_CAPTURED
    ]
    assert final_calls
    speech_event = final_calls[-1].args[1]
    assert speech_event.text == (
        "search for me the latest news about Brazil and Egypt, "
        "and what kind of love is really good for the soul."
    )


@pytest.mark.asyncio
async def test_control_commands(service, mock_bus):
    """Test handling of control commands."""
    await service.start()

    # Test start_session
    await service._on_control(STTCoordinatorControl(action="start_session"))
    assert service._state == STTState.LISTENING
    session_id = service._current_session_id
    assert session_id is not None

    # Cancel the timeout task to prevent hanging
    if service._timeout_task and not service._timeout_task.done():
        service._timeout_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await service._timeout_task

    # Test end_session
    await service._on_control(STTCoordinatorControl(action="end_session"))
    assert service._state == STTState.IDLE
    mock_bus.publish.assert_any_call(
        STTMethods.SESSION_ENDED,
        ANY,
        event=True,
        mesh=True,
        origin="internal",
    )

    # Test reset
    await service._transition_to(STTState.LISTENING)  # force a state change
    await service._on_control(STTCoordinatorControl(action="reset"))
    assert service._state == STTState.IDLE
