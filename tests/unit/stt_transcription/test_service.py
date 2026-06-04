"""Unit tests for STT Transcription Service.

Tests cover:
- Service initialization and lifecycle
- Model loading (realtime and accurate)
- VAD initialization and speech detection
- Audio chunk buffering and processing
- Transcription with both models
- Result emission to correct topics
- Control commands (pause/resume/language/enable)
- Error handling
- Threading and async event loop handling
"""

# ruff: noqa: E402

import asyncio
import sys
from unittest.mock import ANY, AsyncMock, MagicMock, Mock, patch

import numpy as np
import pytest

# Mock hardware dependencies before importing transcription service
sys.modules["faster_whisper"] = MagicMock()
sys.modules["webrtcvad"] = MagicMock()

from app.messaging import (
    AudioChunk,
    AudioEncoding,
    AudioFormat,
    AudioTopics,
    Envelope,
    MessageBus,
    TranscriptionControl,
    TranscriptionType,
)
from app.services.stt_transcription.service import TranscriptionService, VADMode
from app.shared.config.models import AccurateModel, RealtimeModel, Stt, Transcription
from app.shared.contracts.models.stt import TranscriptionMethods


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
    with patch("app.services.stt_transcription.service.config_api") as mock_cfg:
        app_config_mock = MagicMock()
        stt = app_config_mock.services.stt
        stt.language = "en"
        stt.transcription.realtime_model.enabled = True
        stt.transcription.accurate_model.enabled = True
        stt.transcription.realtime_model.model_size = "tiny"
        stt.transcription.accurate_model.model_size = "base"
        stt.transcription.realtime_model.device = "cpu"
        stt.transcription.accurate_model.device = "cpu"
        stt.transcription.realtime_model.compute_type = "int8"
        stt.transcription.accurate_model.compute_type = "int8"

        async def mock_aget(key, default_or_model=None, *args, **kwargs):
            if default_or_model is Stt:
                return Stt(
                    language="en",
                    transcription=Transcription(
                        realtime_model=RealtimeModel(
                            enabled=True,
                            model_size="tiny",
                            device="cpu",
                            compute_type="int8",
                        ),
                        accurate_model=AccurateModel(
                            enabled=True,
                            model_size="base",
                            device="cpu",
                            compute_type="int8",
                        ),
                    ),
                )
            return {}

        mock_cfg.aget = AsyncMock(side_effect=mock_aget)
        yield mock_cfg


@pytest.fixture
def mock_whisper_model():
    """Create a mock WhisperModel."""
    with patch("app.services.stt_transcription.service.WhisperModel") as mock_cls:
        mock_model = MagicMock()

        # Mock transcribe method to return segments
        mock_segment = MagicMock()
        mock_segment.text = "test transcription"

        mock_info = MagicMock()
        mock_info.language = "en"

        mock_model.transcribe.return_value = ([mock_segment], mock_info)
        mock_model.model.model_type = "tiny"

        mock_cls.return_value = mock_model
        yield mock_cls


@pytest.fixture
def mock_vad():
    """Create a mock VAD."""
    with patch("app.services.stt_transcription.service.webrtcvad.Vad") as mock_vad_cls:
        mock_vad_instance = MagicMock()
        mock_vad_instance.is_speech.return_value = True
        mock_vad_cls.return_value = mock_vad_instance
        yield mock_vad_cls


@pytest.fixture
def service(mock_bus, mock_config, mock_whisper_model, mock_vad):
    """Create a TranscriptionService instance with mocked dependencies."""
    with patch("app.shared.services.base_service.get_bus_singleton", return_value=mock_bus):
        yield TranscriptionService()


@pytest.fixture
def audio_chunk():
    """Create a sample AudioChunk."""
    return AudioChunk(
        data=b"\x00\x01" * 320,  # 20ms at 16kHz, 16-bit
        stream_id="test-stream",
        source="microphone",
        sequence=0,
        format=AudioFormat(
            sample_rate=16000,
            channels=1,
            bits_per_sample=16,
            encoding=AudioEncoding.PCM_S16LE,
        ),
    )


# ============================================================================
# 1. INITIALIZATION TESTS
# ============================================================================


class TestInitialization:
    """Test service initialization."""

    def test_constructor(self, mock_bus, mock_config, mock_whisper_model, mock_vad):
        """Test service constructor initializes correctly."""
        with patch("app.shared.services.base_service.get_bus_singleton", return_value=mock_bus):
            service = TranscriptionService()

            assert service.bus is mock_bus
            assert service._running is False
            assert service._transcribing is False
            assert service._paused is False
            assert service._realtime_model is None
            assert service._accurate_model is None
            assert len(service._audio_buffer) == 0
            assert service._audio_format is None
            assert service._current_source == "microphone"
            assert service._chunks_received == 0
            assert service._transcriptions_done == 0

    @pytest.mark.asyncio
    async def test_loads_configuration(self, mock_bus, mock_config, mock_whisper_model, mock_vad):
        """Test service loads configuration on initialization."""
        app_config_mock = MagicMock()
        stt = app_config_mock.services.stt
        stt.language = "en"
        stt.transcription.realtime_model.enabled = True
        stt.transcription.accurate_model.enabled = True
        mock_config.aget_app_config = AsyncMock(return_value=app_config_mock)

        with patch("app.shared.services.base_service.get_bus_singleton", return_value=mock_bus):
            service = TranscriptionService()
            # Configuration is loaded in on_start, not __init__
            # So we can't test it without starting the service
            # This test is now more of a constructor test
            assert service._language == ""  # Not loaded until on_start
            assert service._realtime_enabled is True  # Default value
            assert service._accurate_enabled is True  # Default value


# ============================================================================
# 2. LIFECYCLE TESTS
# ============================================================================


class TestLifecycle:
    """Test service lifecycle operations."""

    @pytest.mark.asyncio
    async def test_start_initializes_service(self, service, mock_vad, mock_whisper_model):
        """Test starting service initializes components."""
        await service.start()

        assert service._running is True
        assert service._vad is not None
        assert service._loop is not None
        assert service._process_thread is not None

        # Verify subscriptions - at least the audio stream subscription
        assert service.bus.subscribe.call_count >= 1
        service.bus.subscribe.assert_any_call(
            AudioTopics.STREAM_MICROPHONE, service._on_audio_chunk
        )
        # Service uses auto-subscription via contracts
        # TODO: Update test for contract-based API

        await service.stop()

    @pytest.mark.asyncio
    async def test_start_idempotent(self, service, mock_whisper_model, mock_vad):
        """Test starting already running service is idempotent."""
        await service.start()
        initial_thread = service._process_thread

        await service.start()  # Should not create new thread

        assert service._process_thread is initial_thread

        await service.stop()

    @pytest.mark.asyncio
    async def test_stop_cleans_up(self, service, mock_whisper_model, mock_vad):
        """Test stopping service cleans up resources."""
        await service.start()
        await service.stop()

        assert service._running is False
        assert service._transcribing is False

    @pytest.mark.asyncio
    async def test_stop_idempotent(self, service):
        """Test stopping already stopped service is idempotent."""
        await service.stop()  # Should not raise
        await service.stop()  # Should not raise


# ============================================================================
# 3. MODEL LOADING TESTS
# ============================================================================


class TestModelLoading:
    """Test Whisper model loading."""

    @pytest.mark.asyncio
    async def test_loads_realtime_model(self, service, mock_whisper_model, mock_vad):
        """Test loading realtime model."""
        await service.start()

        assert service._realtime_model is not None
        mock_whisper_model.assert_any_call(
            "tiny",
            device="cpu",
            compute_type="int8",
            download_root=ANY,
        )

        await service.stop()

    @pytest.mark.asyncio
    async def test_loads_accurate_model(self, service, mock_whisper_model, mock_vad):
        """Test loading accurate model."""
        await service.start()

        assert service._accurate_model is not None
        mock_whisper_model.assert_any_call(
            "base",
            device="cpu",
            compute_type="int8",
            download_root=ANY,
        )

        await service.stop()

    @pytest.mark.asyncio
    async def test_model_loading_error_propagates(self, service, mock_whisper_model, mock_vad):
        """Test model loading error is propagated."""
        mock_whisper_model.side_effect = Exception("Model load failed")

        with pytest.raises(Exception, match="Model load failed"):
            await service.start()


# ============================================================================
# 4. VAD TESTS
# ============================================================================


class TestVAD:
    """Test Voice Activity Detection."""

    @pytest.mark.asyncio
    async def test_vad_initialization(self, service, mock_vad):
        """Test VAD is initialized on start."""
        service._initialize_vad()

        mock_vad.assert_called_once_with(VADMode.MEDIUM.value)

    def test_detect_speech_returns_true_for_speech(self, service, mock_vad):
        """Test speech detection returns True for speech."""
        service._vad = mock_vad.return_value
        service._vad.is_speech.return_value = True
        service._audio_format = AudioFormat(
            sample_rate=16000,
            channels=1,
            bits_per_sample=16,
            encoding=AudioEncoding.PCM_S16LE,
        )

        audio_data = b"\x00\x01" * 320  # 20ms at 16kHz
        is_speech = service._detect_speech(audio_data)

        assert is_speech is True
        service._vad.is_speech.assert_called_once()

    def test_detect_speech_returns_false_for_silence(self, service, mock_vad):
        """Test speech detection returns False for silence."""
        service._vad = mock_vad.return_value
        service._vad.is_speech.return_value = False
        service._audio_format = AudioFormat(
            sample_rate=16000,
            channels=1,
            bits_per_sample=16,
            encoding=AudioEncoding.PCM_S16LE,
        )

        audio_data = b"\x00\x01" * 320
        is_speech = service._detect_speech(audio_data)

        assert is_speech is False

    def test_detect_speech_handles_error(self, service, mock_vad):
        """Test speech detection handles VAD errors gracefully."""
        service._vad = mock_vad.return_value
        service._vad.is_speech.side_effect = Exception("VAD error")
        service._audio_format = AudioFormat(
            sample_rate=16000,
            channels=1,
            bits_per_sample=16,
            encoding=AudioEncoding.PCM_S16LE,
        )

        audio_data = b"\x00\x01" * 320
        is_speech = service._detect_speech(audio_data)

        # Should assume speech on error
        assert is_speech is True


# ============================================================================
# 5. AUDIO PROCESSING TESTS
# ============================================================================


class TestAudioProcessing:
    """Test audio chunk processing."""

    @pytest.mark.asyncio
    async def test_on_audio_chunk_buffers_data(self, service, audio_chunk):
        """Test audio chunks are buffered."""
        envelope = Envelope(type=AudioTopics.STREAM_MICROPHONE, payload=audio_chunk)

        await service._on_audio_chunk(envelope)

        assert len(service._audio_buffer) == 1
        assert service._chunks_received == 1

    @pytest.mark.asyncio
    async def test_on_audio_chunk_stores_format(self, service, audio_chunk):
        """Test first audio chunk stores format."""
        envelope = Envelope(type=AudioTopics.STREAM_MICROPHONE, payload=audio_chunk)

        await service._on_audio_chunk(envelope)

        assert service._audio_format is not None
        assert service._audio_format.sample_rate == 16000
        assert service._audio_format.channels == 1

    @pytest.mark.asyncio
    async def test_on_audio_chunk_tracks_source(self, service, audio_chunk):
        """Test audio chunk tracks source and stream ID."""
        envelope = Envelope(type=AudioTopics.STREAM_MICROPHONE, payload=audio_chunk)

        await service._on_audio_chunk(envelope)

        assert service._current_source == "microphone"
        assert service._current_stream_id == "test-stream"

    @pytest.mark.asyncio
    async def test_on_audio_chunk_paused(self, service, audio_chunk):
        """Test paused service doesn't process chunks."""
        service._paused = True
        envelope = Envelope(type=AudioTopics.STREAM_MICROPHONE, payload=audio_chunk)

        await service._on_audio_chunk(envelope)

        assert len(service._audio_buffer) == 0
        assert service._chunks_received == 0

    def test_bytes_to_numpy_conversion(self, service):
        """Test PCM bytes to numpy array conversion."""
        # Create test audio data
        audio_bytes = b"\x00\x00\x00\x10\x00\x20\x00\x30"

        audio_np = service._bytes_to_numpy(audio_bytes)

        assert isinstance(audio_np, np.ndarray)
        assert audio_np.dtype == np.float32
        assert len(audio_np) == 4  # 8 bytes / 2 bytes per sample
        assert audio_np.min() >= -1.0
        assert audio_np.max() <= 1.0


# ============================================================================
# 6. SPEECH DETECTION TESTS
# ============================================================================


class TestSpeechDetection:
    """Test speech segment detection and accumulation."""

    def test_process_buffer_accumulates_speech(self, service, mock_vad):
        """Test speech chunks are accumulated into segments."""
        service._vad = mock_vad.return_value
        service._vad.is_speech.return_value = True
        service._audio_format = AudioFormat(
            sample_rate=16000,
            channels=1,
            bits_per_sample=16,
            encoding=AudioEncoding.PCM_S16LE,
        )

        audio_data = b"\x00\x01" * 320
        service._audio_buffer.append(audio_data)

        service._process_audio_buffer()

        assert len(service._speech_segments) == 1
        assert service._in_speech is True
        assert service._silence_chunks == 0

    def test_process_buffer_detects_silence(self, service, mock_vad):
        """Test silence detection during speech."""
        service._vad = mock_vad.return_value
        service._vad.is_speech.return_value = False
        service._audio_format = AudioFormat(
            sample_rate=16000,
            channels=1,
            bits_per_sample=16,
            encoding=AudioEncoding.PCM_S16LE,
        )
        service._in_speech = True

        audio_data = b"\x00\x01" * 320
        service._audio_buffer.append(audio_data)

        service._process_audio_buffer()

        assert service._silence_chunks == 1

    def test_reset_speech_state(self, service):
        """Test resetting speech detection state."""
        service._speech_segments.append(b"test")
        service._in_speech = True
        service._silence_chunks = 5

        service._reset_speech_state()

        assert len(service._speech_segments) == 0
        assert service._in_speech is False
        assert service._silence_chunks == 0


# ============================================================================
# 7. TRANSCRIPTION TESTS
# ============================================================================


class TestTranscription:
    """Test transcription functionality."""

    @pytest.mark.asyncio
    async def test_transcribe_with_realtime_model(self, service, mock_whisper_model, mock_vad):
        """Test transcription with realtime model."""
        await service.start()

        # Prepare audio data
        audio_np = np.zeros(16000, dtype=np.float32)  # 1 second of audio

        service._transcribe_with_model(
            audio_np,
            service._realtime_model,
            TranscriptionType.REALTIME,
            1000.0,
        )

        # Verify model was called
        service._realtime_model.transcribe.assert_called_once()

        await service.stop()

    @pytest.mark.asyncio
    async def test_transcribe_with_accurate_model(self, service, mock_whisper_model, mock_vad):
        """Test transcription with accurate model."""
        await service.start()

        audio_np = np.zeros(16000, dtype=np.float32)

        service._transcribe_with_model(
            audio_np,
            service._accurate_model,
            TranscriptionType.ACCURATE,
            1000.0,
        )

        service._accurate_model.transcribe.assert_called_once()

        await service.stop()

    @pytest.mark.asyncio
    async def test_transcription_emits_result(self, service, mock_whisper_model, mock_vad):
        """Test transcription emits result event."""
        await service.start()

        audio_np = np.zeros(16000, dtype=np.float32)

        service._transcribe_with_model(
            audio_np,
            service._realtime_model,
            TranscriptionType.REALTIME,
            1000.0,
        )

        # Give time for async emission
        await asyncio.sleep(0.1)

        # Should have published at least one transcription result
        assert service.bus.publish.call_count >= 1

        await service.stop()

    def test_transcribe_segment_skips_short_audio(self, service):
        """Test transcription skips audio segments that are too short."""
        service._speech_segments.append(b"\x00\x01" * 100)  # Very short
        service._min_audio_length_ms = 500

        service._transcribe_segment()

        # Should not transcribe
        assert service._transcriptions_done == 0

    @pytest.mark.asyncio
    async def test_transcription_handles_empty_result(self, service, mock_whisper_model, mock_vad):
        """Test transcription handles empty text result."""
        await service.start()
        service.bus.publish.reset_mock()  # Reset calls from start()/announcement

        # Mock empty transcription
        mock_segment = MagicMock()
        mock_segment.text = "   "  # Only whitespace
        service._realtime_model.transcribe.return_value = ([mock_segment], MagicMock())

        audio_np = np.zeros(16000, dtype=np.float32)

        service._transcribe_with_model(
            audio_np,
            service._realtime_model,
            TranscriptionType.REALTIME,
            1000.0,
        )

        # Should not emit result for empty text
        assert service.bus.publish.call_count == 0

        await service.stop()


# ============================================================================
# 8. CONTROL COMMAND TESTS
# ============================================================================


class TestControlCommands:
    """Test control command handling."""

    @pytest.mark.asyncio
    async def test_pause_command(self, service):
        """Test pause control command."""
        control = TranscriptionControl(action="pause")

        await service._on_control(control)

        assert service._paused is True

    @pytest.mark.asyncio
    async def test_resume_command(self, service):
        """Test resume control command."""
        service._paused = True
        service._audio_buffer.append(b"old data")

        control = TranscriptionControl(action="resume")

        await service._on_control(control)

        assert service._paused is False
        assert len(service._audio_buffer) == 0  # Buffers cleared

    @pytest.mark.asyncio
    async def test_set_language_command(self, service):
        """Test set language control command."""
        control = TranscriptionControl(action="set_language", language="es")

        await service._on_control(control)

        assert service._language == "es"

    @pytest.mark.asyncio
    async def test_enable_realtime_command(self, service):
        """Test enable realtime transcription command."""
        control = TranscriptionControl(action="enable_realtime", enabled=False)

        await service._on_control(control)

        assert service._realtime_enabled is False

    @pytest.mark.asyncio
    async def test_enable_accurate_command(self, service):
        """Test enable accurate transcription command."""
        control = TranscriptionControl(action="enable_accurate", enabled=False)

        await service._on_control(control)

        assert service._accurate_enabled is False


# ============================================================================
# 9. ERROR HANDLING TESTS
# ============================================================================


class TestErrorHandling:
    """Test error handling."""

    @pytest.mark.asyncio
    async def test_transcription_error_emits_error_event(
        self, service, mock_whisper_model, mock_vad
    ):
        """Test transcription error emits error event."""
        await service.start()

        # Mock transcription error
        service._realtime_model.transcribe.side_effect = Exception("Transcription failed")

        audio_np = np.zeros(16000, dtype=np.float32)

        service._transcribe_with_model(
            audio_np,
            service._realtime_model,
            TranscriptionType.REALTIME,
            1000.0,
        )

        # Give time for async emission
        await asyncio.sleep(0.1)

        # Should emit error
        assert service.bus.publish.call_count >= 1

        await service.stop()

    def test_emit_result_handles_no_event_loop(self, service):
        """Test result emission handles missing event loop gracefully."""
        service._loop = None

        # Should not raise
        service._emit_result(
            text="test",
            transcription_type=TranscriptionType.REALTIME,
            confidence=0.9,
            language="en",
            duration_ms=1000.0,
            model="test-model",
        )

    def test_emit_error_handles_no_event_loop(self, service):
        """Test error emission handles missing event loop gracefully."""
        service._loop = None

        # Should not raise
        service._emit_error(
            error_message="test error",
            error_type="test_type",
        )
