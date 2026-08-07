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
    STTCapturePrepareRequest,
    STTCaptureReleaseRequest,
    STTCaptureStatusRequest,
    STTCoordinatorControl,
    STTListenRequest,
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
    bus.subscribe_event = AsyncMock()
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
        mesh=False,
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
        mesh=False,
        origin="internal",
    )

    # Check that session ended event was published
    mock_bus.publish.assert_any_call(
        STTMethods.SESSION_ENDED,
        ANY,
        event=True,
        mesh=False,
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
        mesh=False,
        origin="internal",
    )

    # Test reset
    await service._transition_to(STTState.LISTENING)  # force a state change
    await service._on_control(STTCoordinatorControl(action="reset"))
    assert service._state == STTState.IDLE


@pytest.mark.asyncio
async def test_capture_prepare_stops_python_before_native_grant(service):
    """Native prepare must release Python capture before returning a lease."""
    service._running = True
    service._capturing = True
    service._capture_owner = "python"
    order = []

    async def stop_capture(reason="user_request"):
        order.append(("stop", reason, service._capture_owner))
        service._capturing = False
        service._stream = None
        service._capture_owner = "none"

    service._stop_audio_capture = AsyncMock(side_effect=stop_capture)

    response = await service._on_capture_prepare(
        STTCapturePrepareRequest(owner_id="tauri-local")
    )

    assert order == [("stop", "native_handoff_prepare", "python")]
    assert response.granted
    assert response.status == "granted"
    assert response.stopped_python_capture
    assert response.owner == "native"
    assert response.lease_id
    assert response.generation == 1
    assert service._capture_owner == "native"
    assert service._capture_owner_id == "tauri-local"
    if service._capture_lease_expiry_task:
        service._capture_lease_expiry_task.cancel()


@pytest.mark.asyncio
async def test_capture_prepare_renews_same_owner_lease_without_rotating_identity(service):
    """Same-owner prepare renews the deadline while keeping lease identity stable."""
    first = await service._on_capture_prepare(
        STTCapturePrepareRequest(owner_id="tauri-local", requested_ttl_s=1)
    )
    first_task = service._capture_lease_expiry_task
    first_expires_at = service._capture_lease_expires_at

    second = await service._on_capture_prepare(
        STTCapturePrepareRequest(
            owner_id="tauri-local",
            lease_id=first.lease_id,
            requested_ttl_s=30,
        )
    )
    await asyncio.sleep(0)

    assert second.granted
    assert second.status == "already_owned"
    assert second.lease_id == first.lease_id
    assert second.generation == first.generation
    assert service._capture_lease_expiry_task is not first_task
    assert service._capture_lease_expires_at is not None
    assert first_expires_at is not None
    assert service._capture_lease_expires_at > first_expires_at
    assert first_task is not None
    assert first_task.done()
    if service._capture_lease_expiry_task:
        service._capture_lease_expiry_task.cancel()


@pytest.mark.asyncio
async def test_capture_prepare_same_owner_requires_current_lease_to_renew(service):
    """A repeated owner ID cannot renew or learn the lease without the active token."""
    first = await service._on_capture_prepare(
        STTCapturePrepareRequest(owner_id="tauri-local", requested_ttl_s=30)
    )

    missing = await service._on_capture_prepare(
        STTCapturePrepareRequest(owner_id="tauri-local", requested_ttl_s=30)
    )
    wrong = await service._on_capture_prepare(
        STTCapturePrepareRequest(
            owner_id="tauri-local",
            lease_id="wrong-lease",
            requested_ttl_s=30,
        )
    )

    assert missing.status == "unavailable"
    assert missing.lease_id is None
    assert wrong.status == "unavailable"
    assert wrong.lease_id is None
    assert service._capture_lease_id == first.lease_id
    assert service._capture_generation == first.generation
    if service._capture_lease_expiry_task:
        service._capture_lease_expiry_task.cancel()


@pytest.mark.asyncio
async def test_capture_prepare_failure_does_not_grant_native_lease(service):
    """Prepare failures keep Python ownership truthful and return redacted status."""
    service._running = True
    service._capturing = True
    service._capture_owner = "python"
    service._stop_audio_capture = AsyncMock(side_effect=RuntimeError("device /dev/snd/pcmC0D0c"))

    response = await service._on_capture_prepare(
        STTCapturePrepareRequest(owner_id="tauri-local")
    )

    assert not response.granted
    assert response.status == "unavailable"
    assert response.owner == "python"
    assert response.lease_id is None
    assert response.message == "python_release_failed"
    assert "/dev" not in response.model_dump_json()
    assert service._capture_owner == "python"


@pytest.mark.asyncio
async def test_capture_prepare_does_not_grant_if_python_thread_survives_stop(service):
    """Native prepare remains unavailable when a Python capture reader survives stop."""
    fake_thread = MagicMock()
    fake_thread.is_alive.return_value = True
    service._running = True
    service._capturing = True
    service._capture_owner = "python"
    service._capture_thread = fake_thread
    service._stream = MagicMock()

    async def run_to_thread(func, *args):
        return func(*args)

    with patch(
        "app.services.stt_coordinator.service.asyncio.to_thread",
        new=AsyncMock(side_effect=run_to_thread),
    ):
        response = await service._on_capture_prepare(
            STTCapturePrepareRequest(owner_id="tauri-local")
        )

    assert not response.granted
    assert response.status == "unavailable"
    assert response.message == "python_release_failed"
    assert service._capture_owner == "python"
    assert service._capturing
    assert service._capture_thread is fake_thread
    service._stream.stop_stream.assert_called_once()
    fake_thread.join.assert_called_once_with(5.0)
    service._stream.close.assert_not_called()


@pytest.mark.asyncio
async def test_capture_prepare_does_not_grant_if_stream_close_fails(service):
    """Native prepare fails closed if PyAudio close does not prove release."""
    fake_thread = MagicMock()
    fake_thread.is_alive.side_effect = [False, False]
    fake_stream = MagicMock()
    fake_stream.close.side_effect = RuntimeError("close failed")
    service._running = True
    service._capturing = True
    service._capture_owner = "python"
    service._capture_thread = fake_thread
    service._stream = fake_stream

    async def run_to_thread(func, *args):
        return func(*args)

    with patch(
        "app.services.stt_coordinator.service.asyncio.to_thread",
        new=AsyncMock(side_effect=run_to_thread),
    ):
        response = await service._on_capture_prepare(
            STTCapturePrepareRequest(owner_id="tauri-local")
        )

    assert not response.granted
    assert response.status == "unavailable"
    assert response.message == "python_release_failed"
    assert service._capture_owner == "python"
    assert service._capturing
    assert service._stream is fake_stream
    fake_stream.stop_stream.assert_called_once()
    fake_stream.close.assert_called_once()


@pytest.mark.asyncio
async def test_capture_release_rejects_stale_and_foreign_leases(service):
    """Only the exact native owner, lease, and generation can release capture."""
    prepare = await service._on_capture_prepare(
        STTCapturePrepareRequest(owner_id="tauri-local")
    )

    stale = await service._on_capture_release(
        STTCaptureReleaseRequest(
            owner_id="tauri-local",
            lease_id=prepare.lease_id or "missing",
            generation=prepare.generation - 1,
            restart_python_capture=False,
        )
    )
    foreign = await service._on_capture_release(
        STTCaptureReleaseRequest(
            owner_id="other-runtime",
            lease_id=prepare.lease_id or "missing",
            generation=prepare.generation,
            restart_python_capture=False,
        )
    )

    assert stale.status == "rejected"
    assert foreign.status == "rejected"
    assert service._capture_owner == "native"
    assert service._capture_generation == prepare.generation
    if service._capture_lease_expiry_task:
        service._capture_lease_expiry_task.cancel()


@pytest.mark.asyncio
async def test_capture_release_is_idempotent_for_same_released_lease(service):
    """A duplicate release for the same native lease is safe and does not restart twice."""
    prepare = await service._on_capture_prepare(
        STTCapturePrepareRequest(owner_id="tauri-local")
    )
    lease_id = prepare.lease_id or "missing"
    lease_task = service._capture_lease_expiry_task

    first = await service._on_capture_release(
        STTCaptureReleaseRequest(
            owner_id="tauri-local",
            lease_id=lease_id,
            generation=prepare.generation,
            restart_python_capture=False,
        )
    )
    second = await service._on_capture_release(
        STTCaptureReleaseRequest(
            owner_id="tauri-local",
            lease_id=lease_id,
            generation=prepare.generation,
            restart_python_capture=False,
        )
    )

    assert first.status == "released"
    assert first.released
    assert second.status == "already_released"
    assert second.released
    assert service._capture_owner == "none"
    assert service._capture_generation == prepare.generation + 1
    assert lease_task is not None
    assert lease_task.done()


@pytest.mark.asyncio
async def test_capture_release_restarts_python_only_when_lifecycle_allows(service):
    """Native release restarts PyAudio capture only when service and config allow it."""
    service._running = True
    service._audio_input_available = True
    service._pyaudio = MagicMock()
    prepare = await service._on_capture_prepare(
        STTCapturePrepareRequest(owner_id="tauri-local")
    )

    async def start_capture():
        service._capturing = True
        service._capture_owner = "python"

    service._start_audio_capture = AsyncMock(side_effect=start_capture)

    response = await service._on_capture_release(
        STTCaptureReleaseRequest(
            owner_id="tauri-local",
            lease_id=prepare.lease_id or "missing",
            generation=prepare.generation,
        )
    )

    assert response.status == "released"
    assert response.restarted_python_capture
    assert response.python_capture_active
    assert service._capture_owner == "python"
    service._start_audio_capture.assert_awaited_once()


@pytest.mark.asyncio
async def test_concurrent_capture_prepare_serializes_to_one_native_owner(service):
    """Concurrent native prepares must not create two active capture owners."""
    service._running = True
    service._capturing = True
    service._capture_owner = "python"

    async def stop_capture(reason="user_request"):
        await asyncio.sleep(0.01)
        service._capturing = False
        service._stream = None
        service._capture_owner = "none"

    service._stop_audio_capture = AsyncMock(side_effect=stop_capture)

    first, second = await asyncio.gather(
        service._on_capture_prepare(STTCapturePrepareRequest(owner_id="runtime-a")),
        service._on_capture_prepare(STTCapturePrepareRequest(owner_id="runtime-b")),
    )

    granted = [response for response in (first, second) if response.granted]
    rejected = [response for response in (first, second) if not response.granted]
    assert len(granted) == 1
    assert len(rejected) == 1
    assert rejected[0].status == "unavailable"
    assert service._capture_owner == "native"
    assert service._capture_owner_id in {"runtime-a", "runtime-b"}
    if service._capture_lease_expiry_task:
        service._capture_lease_expiry_task.cancel()


@pytest.mark.asyncio
async def test_capture_status_is_redacted(service):
    """Status exposes ownership state without device paths or audio payloads."""
    service._device_index = 7
    service._audio_source = "/dev/snd/private"
    await service._on_capture_prepare(
        STTCapturePrepareRequest(owner_id="tauri-local", requested_ttl_s=30)
    )

    status = await service._on_capture_status(STTCaptureStatusRequest())
    payload = status.model_dump_json()

    assert status.owner == "native"
    assert status.native_lease_active
    assert status.lease_expires_at is not None
    assert status.redacted
    assert "lease-" not in payload
    assert "tauri-local" not in payload
    assert "/dev" not in payload
    assert "private" not in payload
    if service._capture_lease_expiry_task:
        service._capture_lease_expiry_task.cancel()


@pytest.mark.asyncio
async def test_capture_prepare_quiesces_active_session_and_ignores_late_transcription(
    service, mock_bus
):
    """Native prepare ends active Python STT work and ignores queued final results."""
    await service._start_session("manual_start", session_id="legacy-session")
    service._ambient_transcription_enabled = True

    response = await service._on_capture_prepare(
        STTCapturePrepareRequest(owner_id="tauri-local")
    )

    assert response.granted
    assert service._state == STTState.IDLE
    assert service._current_session_id is None
    mock_bus.publish.assert_any_call(
        TranscriptionTopics.CONTROL, TranscriptionControl(action="pause"), event=False
    )

    mock_bus.publish.reset_mock()
    await service._on_transcription_result(
        Envelope(
            payload=TranscriptionResult(
                text="late python speech",
                transcription_type=TranscriptionType.ACCURATE,
                source="test_source",
                stream_id="test_stream",
                model="test_model",
                duration_ms=1000,
            ),
            type=TranscriptionTopics.RESULT,
        )
    )

    assert mock_bus.publish.await_args_list == []
    if service._capture_lease_expiry_task:
        service._capture_lease_expiry_task.cancel()


@pytest.mark.asyncio
async def test_capture_prepare_waits_for_late_wakeword_handler_before_grant(
    service, mock_bus
):
    """Prepare cannot grant between a stale wakeword check and session mutation."""
    entered_start = asyncio.Event()
    release_start = asyncio.Event()
    original_start_session = service._start_session

    async def delayed_start_session(wake_word, session_id=None):
        entered_start.set()
        await release_start.wait()
        await original_start_session(wake_word, session_id=session_id)

    service._start_session = AsyncMock(side_effect=delayed_start_session)
    wake_task = asyncio.create_task(
        service._on_wake_word_detected(
            Envelope(
                payload=WakeWordDetected(
                    wake_word="jarvis",
                    confidence=0.9,
                    source="test_source",
                    stream_id="test_stream",
                    backend=WakeWordBackendType.OPENWAKEWORD,
                ),
                type=WakeWordTopics.DETECTED,
            )
        )
    )
    await entered_start.wait()

    prepare_task = asyncio.create_task(
        service._on_capture_prepare(STTCapturePrepareRequest(owner_id="tauri-local"))
    )
    await asyncio.sleep(0)
    assert not prepare_task.done()

    release_start.set()
    await wake_task
    response = await prepare_task

    assert response.granted
    assert service._capture_owner == "native"
    assert service._state == STTState.IDLE
    assert service._current_session_id is None
    session_ended_calls = [
        c for c in mock_bus.publish.await_args_list if c.args[0] == STTMethods.SESSION_ENDED
    ]
    assert session_ended_calls
    if service._capture_lease_expiry_task:
        service._capture_lease_expiry_task.cancel()


@pytest.mark.asyncio
async def test_native_capture_ignores_late_wakeword_partial_and_manual_listen(
    service, mock_bus
):
    """Native ownership blocks Python wake, partial transcription, and listen starts."""
    service._capture_owner = "native"
    service._capture_owner_id = "tauri-local"
    service._capture_lease_id = "lease-1"

    await service._on_wake_word_detected(
        Envelope(
            payload=WakeWordDetected(
                wake_word="jarvis",
                confidence=0.9,
                source="test_source",
                stream_id="test_stream",
                backend=WakeWordBackendType.OPENWAKEWORD,
            ),
            type=WakeWordTopics.DETECTED,
        )
    )
    await service._on_transcription_result(
        Envelope(
            payload=TranscriptionResult(
                text="late partial",
                transcription_type=TranscriptionType.PARTIAL,
                source="test_source",
                stream_id="test_stream",
                model="test_model",
                duration_ms=100,
            ),
            type=TranscriptionTopics.RESULT,
        )
    )
    listen = await service._on_listen(STTListenRequest(session_id="manual-blocked"))
    await service._on_control(STTCoordinatorControl(action="start_session"))

    assert service._state == STTState.IDLE
    assert service._current_session_id is None
    assert not listen.success
    assert listen.status == "unavailable"
    assert mock_bus.publish.await_args_list == []


@pytest.mark.asyncio
async def test_native_capture_lease_expiry_recovers_stale_owner(service):
    """Expired native ownership releases fail-closed and restarts Python when allowed."""
    service._running = True
    service._audio_input_available = True
    service._pyaudio = MagicMock()

    async def start_capture():
        service._capturing = True
        service._capture_owner = "python"

    service._start_audio_capture = AsyncMock(side_effect=start_capture)

    prepare = await service._on_capture_prepare(
        STTCapturePrepareRequest(owner_id="tauri-local", requested_ttl_s=1)
    )
    await asyncio.sleep(1.05)

    assert service._capture_owner == "python"
    assert service._capturing
    assert service._capture_generation == prepare.generation + 1
    assert service._capture_lease_id is None
    service._start_audio_capture.assert_awaited_once()


@pytest.mark.asyncio
async def test_capture_release_python_restart_failure_rolls_back_to_no_owner(service):
    """A Python restart failure after native release must not leave a false owner."""
    service._running = True
    service._audio_input_available = True
    service._pyaudio = MagicMock()
    prepare = await service._on_capture_prepare(
        STTCapturePrepareRequest(owner_id="tauri-local")
    )
    service._start_audio_capture = AsyncMock(side_effect=RuntimeError("device disappeared"))

    response = await service._on_capture_release(
        STTCaptureReleaseRequest(
            owner_id="tauri-local",
            lease_id=prepare.lease_id or "missing",
            generation=prepare.generation,
        )
    )

    assert response.released
    assert response.status == "python_unavailable"
    assert not response.python_capture_active
    assert service._capture_owner == "none"
    assert not service._capturing


@pytest.mark.asyncio
async def test_stop_audio_capture_joins_thread_without_blocking_event_loop(service, mock_bus):
    """Stopping PyAudio capture stops stream then joins/closes off the event loop."""
    fake_thread = MagicMock()
    fake_thread.is_alive.side_effect = [True, True, False]
    service._capturing = True
    service._capture_owner = "python"
    service._capture_thread = fake_thread
    fake_stream = MagicMock()
    service._stream = fake_stream
    service._loop = None

    async def run_to_thread(func, *args):
        return func(*args)

    with patch(
        "app.services.stt_coordinator.service.asyncio.to_thread",
        new=AsyncMock(side_effect=run_to_thread),
    ) as to_thread:
        await service._stop_audio_capture("native_handoff_prepare")

    to_thread.assert_has_awaits(
        [
            call(fake_stream.stop_stream),
            call(fake_thread.join, 5.0),
            call(fake_stream.close),
        ]
    )
    assert service._capture_thread is None
    assert service._capture_owner == "none"
    assert not service._capturing
    mock_bus.publish.assert_not_called()


@pytest.mark.asyncio
async def test_service_stop_clears_native_capture_owner(service):
    """Service shutdown releases any native lease and increments generation."""
    service._running = True
    service._capture_owner = "native"
    service._capture_owner_id = "tauri-local"
    service._capture_lease_id = "lease-1"
    service._capture_generation = 3
    lease_task = asyncio.create_task(asyncio.sleep(60))
    service._capture_lease_expiry_task = lease_task
    service.bus.unsubscribe = MagicMock()

    await service.on_stop()

    assert service._capture_owner == "none"
    assert service._capture_owner_id is None
    assert service._capture_lease_id is None
    assert service._capture_generation == 4
    assert lease_task.done()
