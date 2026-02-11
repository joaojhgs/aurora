"""Unit tests for STT Wake Word Service.

Tests cover:
- Service initialization and lifecycle
- Configuration loading
- Backend initialization (OpenWakeWord, Porcupine)
- Audio chunk processing
- Wake word detection
- Control commands (start/stop/pause/resume)
- Error handling
"""

import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, Mock, patch

import pytest

from app.messaging import AudioChunk, AudioFormat, AudioTopics, Envelope, MessageBus
from app.services.stt_wakeword.messages import (
    WakeWordBackendType,
    WakeWordControl,
    WakeWordDetected,
)
from app.services.stt_wakeword.service import WakeWordService
from app.shared.contracts.models.stt import WakeWordMethods

# Mock hardware dependencies before imports
sys.modules["openwakeword"] = MagicMock()
sys.modules["openwakeword.model"] = MagicMock()
sys.modules["pvporcupine"] = MagicMock()


@pytest.fixture
def mock_bus():
    """Create a mock message bus."""
    bus = Mock(spec=MessageBus)
    bus.subscribe = Mock()
    bus.publish = AsyncMock()
    return bus


@pytest.fixture
def mock_config():
    """Mock config manager to avoid loading real config."""
    with patch("app.services.stt_wakeword.service.config_api") as mock_cfg:
        mock_cfg.get.side_effect = lambda key, default: {
            "general.speech_to_text.wake_word.backend": "oww",
            "general.speech_to_text.wake_word.threshold": 0.5,
            "general.speech_to_text.wake_word.model_path": "voice_models/jarvis.onnx",
        }.get(key, default)
        yield mock_cfg


@pytest.fixture
def mock_backend():
    """Create a mock wake word backend."""
    backend = Mock()
    backend.initialize = AsyncMock()
    backend.cleanup = AsyncMock()
    backend.detect = AsyncMock()
    return backend


@pytest.fixture
def service(mock_bus, mock_config):
    """Create WakeWordService instance with mocked dependencies."""
    with patch("app.shared.services.base_service.get_bus_singleton", return_value=mock_bus):
        return WakeWordService()


# ============================================================================
# Initialization Tests
# ============================================================================


def test_service_initialization(service, mock_bus):
    """Test service initializes with correct defaults."""
    # Service uses singleton bus now
    assert service is not None
    assert service._running is False
    assert service._enabled is False
    assert service._backend is None
    assert service._backend_type is None


# ============================================================================
# Configuration Tests
# ============================================================================


@pytest.mark.asyncio
async def test_load_config_with_string_model_path(mock_bus):
    """Test loading configuration with string model path."""
    with patch("app.services.stt_wakeword.service.config_api") as mock_cfg:
        mock_cfg.aget = AsyncMock(side_effect=lambda key, default: {
            "general.speech_to_text.wake_word.backend": "oww",
            "general.speech_to_text.wake_word.threshold": 0.7,
            "general.speech_to_text.wake_word.model_path": "voice_models/aurora.onnx",
        }.get(key, default))

        with (
            patch("app.shared.services.base_service.get_bus_singleton", return_value=mock_bus),
            patch("app.shared.path_utils.resolve_path", side_effect=lambda p: Path(p)),
        ):
            service = WakeWordService()
        await service._load_config()
        assert service._wake_words == ["aurora"]


@pytest.mark.asyncio
async def test_load_config_with_list_model_paths(mock_bus):
    """Test loading configuration with multiple model paths."""
    with patch("app.services.stt_wakeword.service.config_api") as mock_cfg:
        mock_cfg.aget = AsyncMock(side_effect=lambda key, default: {
            "general.speech_to_text.wake_word.backend": "pvp",  # Use correct enum value
            "general.speech_to_text.wake_word.threshold": 0.6,
            "general.speech_to_text.wake_word.model_path": [
                "voice_models/aurora.ppn",
                "voice_models/jarvis.ppn",
            ],
        }.get(key, default))

        with (
            patch("app.shared.services.base_service.get_bus_singleton", return_value=mock_bus),
            patch("app.shared.path_utils.resolve_path", side_effect=lambda p: Path(p)),
        ):
            service = WakeWordService()
        await service._load_config()
        assert service._wake_words == ["aurora", "jarvis"]


@pytest.mark.asyncio
async def test_load_config_with_none_model_path(mock_bus):
    """Test loading configuration with None model path uses default."""
    with patch("app.services.stt_wakeword.service.config_api") as mock_cfg:
        mock_cfg.aget = AsyncMock(side_effect=lambda key, default: {
            "general.speech_to_text.wake_word.backend": "oww",
            "general.speech_to_text.wake_word.threshold": 0.5,
            "general.speech_to_text.wake_word.model_path": None,
        }.get(key, default))

        with (
            patch("app.shared.services.base_service.get_bus_singleton", return_value=mock_bus),
            patch("app.shared.path_utils.resolve_path", side_effect=lambda p: Path(p)),
        ):
            service = WakeWordService()
        await service._load_config()
        assert service._wake_words == ["jarvis"]


# ============================================================================
# Backend Initialization Tests
# ============================================================================


@pytest.mark.asyncio
async def test_initialize_openwakeword_backend(service):
    """Test initialization of OpenWakeWord backend."""
    service._backend_type = WakeWordBackendType.OPENWAKEWORD
    service._model_paths = ["voice_models/jarvis.onnx"]
    service._sensitivity = 0.5
    service._wake_words = ["jarvis"]

    with patch("app.services.stt_wakeword.service.OpenWakeWordBackend") as mock_oww_class:
        mock_backend = Mock()
        mock_backend.initialize = AsyncMock()
        mock_oww_class.return_value = mock_backend

        await service._initialize_backend()

        mock_oww_class.assert_called_once_with(
            model_paths=["voice_models/jarvis.onnx"], sensitivity=0.5, wake_words=["jarvis"]
        )
        mock_backend.initialize.assert_called_once()
        assert service._backend == mock_backend


@pytest.mark.asyncio
async def test_initialize_porcupine_backend(service):
    """Test initialization of Porcupine backend."""
    service._backend_type = WakeWordBackendType.PORCUPINE
    service._model_paths = ["voice_models/aurora.ppn"]
    service._sensitivity = 0.7
    service._wake_words = ["aurora"]

    with patch("app.services.stt_wakeword.service.PorcupineBackend") as mock_porcupine_class:
        mock_backend = Mock()
        mock_backend.initialize = AsyncMock()
        mock_porcupine_class.return_value = mock_backend

        await service._initialize_backend()

        mock_porcupine_class.assert_called_once_with(
            model_paths=["voice_models/aurora.ppn"], sensitivity=0.7, wake_words=["aurora"]
        )
        mock_backend.initialize.assert_called_once()
        assert service._backend == mock_backend


@pytest.mark.asyncio
async def test_initialize_unknown_backend_raises_error(service):
    """Test initialization with unknown backend raises ValueError."""
    service._backend_type = Mock(value="unknown")

    with pytest.raises(ValueError, match="Unknown wake word backend"):
        await service._initialize_backend()


# ============================================================================
# Service Lifecycle Tests
# ============================================================================


@pytest.mark.asyncio
async def test_start_service(service, mock_bus):
    """Test starting the wake word service."""
    # Set backend type since we're mocking _load_config
    service._backend_type = WakeWordBackendType.OPENWAKEWORD

    with (
        patch.object(service, "_load_config", new_callable=AsyncMock),
        patch.object(service, "_initialize_backend", new_callable=AsyncMock),
    ):
        await service.start()

        assert service._running is True
        assert service._enabled is True

        # Verify subscriptions - at least the microphone stream
        assert any(call.args[0] == AudioTopics.STREAM_MICROPHONE for call in mock_bus.subscribe.call_args_list), (
            "Missing subscription to STREAM_MICROPHONE"
        )


@pytest.mark.asyncio
async def test_stop_service(service):
    """Test stopping the wake word service."""
    # Setup service with a backend
    mock_backend = AsyncMock()
    mock_backend.cleanup = AsyncMock()
    service._backend = mock_backend
    service._running = True
    service._enabled = True
    service._started = True

    await service.stop()

    assert service._running is False
    assert service._enabled is False
    assert service._backend is None
    mock_backend.cleanup.assert_awaited_once()


@pytest.mark.asyncio
async def test_stop_service_without_backend(service):
    """Test stopping service when no backend is initialized."""
    service._running = True
    service._enabled = True
    service._backend = None
    service._started = True

    # Should not raise error
    await service.stop()

    assert service._running is False
    assert service._enabled is False


# ============================================================================
# Audio Processing Tests
# ============================================================================


@pytest.mark.asyncio
async def test_on_audio_chunk_when_enabled(service, mock_backend):
    """Test audio chunk processing when service is enabled."""
    service._enabled = True
    service._backend = mock_backend

    # Create mock detection result
    mock_result = Mock()
    mock_result.detected = False
    mock_backend.detect.return_value = mock_result

    chunk = AudioChunk(
        data=b"audio_data",
        stream_id="test-stream",
        source="microphone",
        sequence=0,
        format=AudioFormat(sample_rate=16000, channels=1, bits_per_sample=16),
    )
    envelope = Envelope(type="event", payload=chunk)

    await service._on_audio_chunk(envelope)

    # Verify backend detect was called
    mock_backend.detect.assert_called_once_with(b"audio_data")

    # Verify stream tracking
    assert service._current_stream_id == "test-stream"
    assert service._current_source == "microphone"
    assert service._audio_format is not None


@pytest.mark.asyncio
async def test_on_audio_chunk_when_disabled(service, mock_backend):
    """Test audio chunk is ignored when service is disabled."""
    service._enabled = False
    service._backend = mock_backend

    chunk = AudioChunk(data=b"audio_data", sequence=0, stream_id="test-stream", source="microphone")
    envelope = Envelope(type="event", payload=chunk)

    await service._on_audio_chunk(envelope)

    # Verify backend detect was NOT called
    mock_backend.detect.assert_not_called()


@pytest.mark.asyncio
async def test_on_audio_chunk_without_backend(service):
    """Test audio chunk is ignored when backend is not initialized."""
    service._enabled = True
    service._backend = None

    chunk = AudioChunk(data=b"audio_data", sequence=0, stream_id="test-stream", source="microphone")
    envelope = Envelope(type="event", payload=chunk)

    # Should not raise error
    await service._on_audio_chunk(envelope)


@pytest.mark.asyncio
async def test_on_audio_chunk_with_exception(service, mock_backend):
    """Test audio chunk processing handles exceptions gracefully."""
    service._enabled = True
    service._backend = mock_backend
    mock_backend.detect.side_effect = Exception("Detection error")

    chunk = AudioChunk(data=b"audio_data", sequence=0, stream_id="test-stream", source="microphone")
    envelope = Envelope(type="event", payload=chunk)

    # Should not raise exception
    await service._on_audio_chunk(envelope)


# ============================================================================
# Wake Word Detection Tests
# ============================================================================


@pytest.mark.asyncio
async def test_wake_word_detected_emits_event(service, mock_backend, mock_bus):
    """Test wake word detection emits WakeWordDetected event."""
    service._enabled = True
    service._backend = mock_backend
    service._wake_words = ["aurora", "jarvis"]
    service._backend_type = WakeWordBackendType.OPENWAKEWORD

    # Create mock detection result with detection
    mock_result = Mock()
    mock_result.detected = True
    mock_result.wake_word_index = 0
    mock_result.confidence = 0.95
    mock_backend.detect.return_value = mock_result

    chunk = AudioChunk(data=b"audio_data", sequence=0, stream_id="test-stream", source="microphone")
    envelope = Envelope(type="event", payload=chunk)

    await service._on_audio_chunk(envelope)

    # Verify event was published
    mock_bus.publish.assert_called_once()
    call_args = mock_bus.publish.call_args

    assert call_args[0][0] == WakeWordMethods.DETECTED
    event = call_args[0][1]
    assert isinstance(event, WakeWordDetected)
    assert event.wake_word == "aurora"
    assert event.confidence == 0.95
    assert event.source == "microphone"
    assert event.stream_id == "test-stream"
    assert event.backend == WakeWordBackendType.OPENWAKEWORD


@pytest.mark.asyncio
async def test_wake_word_not_detected_no_event(service, mock_backend, mock_bus):
    """Test no event is emitted when wake word is not detected."""
    service._enabled = True
    service._backend = mock_backend

    # Create mock detection result without detection
    mock_result = Mock()
    mock_result.detected = False
    mock_backend.detect.return_value = mock_result

    chunk = AudioChunk(data=b"audio_data", sequence=0, stream_id="test-stream", source="microphone")
    envelope = Envelope(type="event", payload=chunk)

    await service._on_audio_chunk(envelope)

    # Verify no event was published
    mock_bus.publish.assert_not_called()


@pytest.mark.asyncio
async def test_wake_word_detection_with_multiple_models(service, mock_backend, mock_bus):
    """Test wake word detection with multiple wake word models."""
    service._enabled = True
    service._backend = mock_backend
    service._wake_words = ["aurora", "jarvis", "computer"]
    service._backend_type = WakeWordBackendType.PORCUPINE

    # Detect second wake word
    mock_result = Mock()
    mock_result.detected = True
    mock_result.wake_word_index = 1
    mock_result.confidence = 0.88
    mock_backend.detect.return_value = mock_result

    chunk = AudioChunk(data=b"audio_data", sequence=0, stream_id="test-stream", source="microphone")
    envelope = Envelope(type="event", payload=chunk)

    await service._on_audio_chunk(envelope)

    # Verify correct wake word was published
    call_args = mock_bus.publish.call_args
    event = call_args[0][1]
    assert event.wake_word == "jarvis"


# ============================================================================
# Control Command Tests
# ============================================================================


@pytest.mark.asyncio
async def test_control_command_start(service):
    """Test start control command enables detection."""
    service._enabled = False

    cmd = WakeWordControl(action="start")
    envelope = Envelope(type="command", payload=cmd)

    await service._on_control(envelope)

    assert service._enabled is True


@pytest.mark.asyncio
async def test_control_command_stop(service):
    """Test stop control command disables detection."""
    service._enabled = True

    cmd = WakeWordControl(action="stop")
    envelope = Envelope(type="command", payload=cmd)

    await service._on_control(envelope)

    assert service._enabled is False


@pytest.mark.asyncio
async def test_control_command_pause(service):
    """Test pause control command disables detection."""
    service._enabled = True

    cmd = WakeWordControl(action="pause")
    envelope = Envelope(type="command", payload=cmd)

    await service._on_control(envelope)

    assert service._enabled is False


@pytest.mark.asyncio
async def test_control_command_resume(service):
    """Test resume control command enables detection."""
    service._enabled = False

    cmd = WakeWordControl(action="resume")
    envelope = Envelope(type="command", payload=cmd)

    await service._on_control(envelope)

    assert service._enabled is True


@pytest.mark.asyncio
async def test_control_command_case_insensitive(service):
    """Test control commands are case-insensitive."""
    service._enabled = False

    cmd = WakeWordControl(action="START")
    envelope = Envelope(type="command", payload=cmd)

    await service._on_control(envelope)

    assert service._enabled is True


@pytest.mark.asyncio
async def test_control_command_unknown_action(service):
    """Test unknown control action is handled gracefully."""
    initial_state = service._enabled

    cmd = WakeWordControl(action="unknown_action")
    envelope = Envelope(type="command", payload=cmd)

    # Should not raise exception
    await service._on_control(envelope)

    # State should not change
    assert service._enabled == initial_state


@pytest.mark.asyncio
async def test_control_command_with_exception(service):
    """Test control command handling with exception."""
    # Create an invalid control command that will cause attribute access error
    # Use a WakeWordControl with action that causes exception during processing
    cmd = WakeWordControl(action="test")

    # Patch to make the action processing raise an exception
    with patch.object(service, "_enabled", side_effect=Exception("Test exception")):
        envelope = Envelope(type="command", payload=cmd)

        # Should not raise exception - errors are caught and logged
        await service._on_control(envelope)


# ============================================================================
# Error Handling Tests
# ============================================================================


@pytest.mark.asyncio
async def test_process_audio_chunk_with_detection_error(service, mock_backend, mock_bus):
    """Test error handling during wake word detection."""
    service._enabled = True
    service._backend = mock_backend
    mock_backend.detect.side_effect = Exception("Backend error")

    chunk = AudioChunk(data=b"audio_data", sequence=0, stream_id="test-stream", source="microphone")

    # Should not raise exception
    await service._process_audio_chunk(chunk)

    # No event should be published due to error
    mock_bus.publish.assert_not_called()


# ============================================================================
# Stream Tracking Tests
# ============================================================================


@pytest.mark.asyncio
async def test_stream_id_tracking(service, mock_backend):
    """Test service tracks current stream ID."""
    service._enabled = True
    service._backend = mock_backend
    mock_backend.detect.return_value = Mock(detected=False)

    chunk1 = AudioChunk(data=b"data1", sequence=0, stream_id="stream-1", source="mic")
    envelope1 = Envelope(type="event", payload=chunk1)
    await service._on_audio_chunk(envelope1)

    assert service._current_stream_id == "stream-1"
    assert service._current_source == "mic"

    chunk2 = AudioChunk(data=b"data2", sequence=0, stream_id="stream-2", source="file")
    envelope2 = Envelope(type="event", payload=chunk2)
    await service._on_audio_chunk(envelope2)

    assert service._current_stream_id == "stream-2"
    assert service._current_source == "file"


@pytest.mark.asyncio
async def test_audio_format_tracking(service, mock_backend):
    """Test service tracks audio format."""
    service._enabled = True
    service._backend = mock_backend
    mock_backend.detect.return_value = Mock(detected=False)

    audio_format = AudioFormat(sample_rate=16000, channels=1, bits_per_sample=16)
    chunk = AudioChunk(
        data=b"audio_data",
        sequence=0,
        stream_id="test-stream",
        source="microphone",
        format=audio_format,
    )
    envelope = Envelope(type="event", payload=chunk)

    await service._on_audio_chunk(envelope)

    assert service._audio_format == audio_format
    assert service._audio_format.sample_rate == 16000
    assert service._audio_format.channels == 1
    assert service._audio_format.bits_per_sample == 16
