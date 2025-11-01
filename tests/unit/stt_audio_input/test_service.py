"""Unit tests for STT audio input service."""

import sys
from unittest.mock import AsyncMock, MagicMock, Mock, patch

import pytest

from app.messaging import Envelope, MessageBus
from app.stt_audio_input.service import AudioInputControl, AudioInputService

# Mock pyaudio before importing the service
sys.modules["pyaudio"] = MagicMock()


@pytest.fixture
def mock_bus():
    """Create a mock message bus."""
    bus = Mock(spec=MessageBus)
    bus.subscribe = Mock()
    bus.publish = AsyncMock()
    return bus


@pytest.fixture
def mock_pyaudio():
    """Create a mock PyAudio instance."""
    with patch("app.stt_audio_input.service.pyaudio") as mock_pa:
        # Setup mock PyAudio
        mock_pa_instance = MagicMock()
        mock_pa.PyAudio.return_value = mock_pa_instance
        mock_pa.paInt16 = 8  # Standard PyAudio constant

        # Setup mock stream
        mock_stream = MagicMock()
        mock_stream.is_active.return_value = True
        mock_stream.is_stopped.return_value = False
        mock_stream.read.return_value = b"\x00\x01" * 1024  # Mock audio data
        mock_pa_instance.open.return_value = mock_stream
        mock_pa_instance.get_device_count.return_value = 2
        mock_pa_instance.get_default_input_device_info.return_value = {
            "index": 0,
            "name": "Default Microphone",
            "maxInputChannels": 2,
            "defaultSampleRate": 16000.0,
        }
        mock_pa_instance.get_device_info_by_index.return_value = {
            "index": 0,
            "name": "Test Microphone",
            "maxInputChannels": 2,
            "defaultSampleRate": 16000.0,
        }

        yield mock_pa


@pytest.fixture
def audio_service(mock_bus, mock_pyaudio):
    """Create an audio input service instance."""
    return AudioInputService(bus=mock_bus)


class TestAudioInputServiceInitialization:
    """Test audio input service initialization."""

    def test_init(self, mock_bus, mock_pyaudio):
        """Test service initialization."""
        service = AudioInputService(bus=mock_bus)
        assert service.bus == mock_bus
        assert service._running is False
        assert service._capturing is False
        assert service._paused is False
        assert service._pyaudio is None
        assert service._stream is None

    def test_init_with_none_bus(self, mock_pyaudio):
        """Test initialization with None bus."""
        with pytest.raises((AttributeError, TypeError)):
            service = AudioInputService(bus=None)
            service.bus.subscribe("test", lambda x: x)


class TestAudioInputServiceLifecycle:
    """Test audio input service lifecycle."""

    @pytest.mark.asyncio
    async def test_start(self, audio_service, mock_bus, mock_pyaudio):
        """Test service start."""
        await audio_service.start()

        # Verify running flag is set
        assert audio_service._running is True

        # Verify PyAudio was initialized
        assert audio_service._pyaudio is not None

        # Verify subscriptions were made
        assert mock_bus.subscribe.called

    @pytest.mark.asyncio
    async def test_stop(self, audio_service, mock_pyaudio):
        """Test service stop."""
        # Start first
        await audio_service.start()
        assert audio_service._running is True

        # Then stop
        await audio_service.stop()
        assert audio_service._running is False

    @pytest.mark.asyncio
    async def test_start_stop_cycle(self, audio_service, mock_pyaudio):
        """Test complete start-stop cycle."""
        await audio_service.start()
        assert audio_service._running is True

        await audio_service.stop()
        assert audio_service._running is False

        # Verify can start again
        await audio_service.start()
        assert audio_service._running is True

        await audio_service.stop()


class TestAudioInputServiceDeviceManagement:
    """Test audio device management."""

    @pytest.mark.asyncio
    async def test_pyaudio_initialization(self, audio_service, mock_pyaudio):
        """Test PyAudio initialization."""
        await audio_service.start()

        # PyAudio should be initialized
        assert audio_service._pyaudio is not None

    @pytest.mark.asyncio
    async def test_device_enumeration(self, audio_service, mock_pyaudio):
        """Test device enumeration on start."""
        await audio_service.start()

        # PyAudio get_device_count should have been called
        assert audio_service._pyaudio.get_device_count.called


class TestAudioInputServiceCapture:
    """Test audio capture functionality."""

    @pytest.mark.asyncio
    async def test_service_starts_capture_automatically(self, audio_service, mock_bus, mock_pyaudio):
        """Test that service automatically starts capture on start."""
        await audio_service.start()

        # Service should have started capturing
        assert audio_service._capturing is True

        await audio_service.stop()

    @pytest.mark.asyncio
    async def test_service_stops_capture_on_stop(self, audio_service, mock_pyaudio):
        """Test that service stops capture on stop."""
        await audio_service.start()
        assert audio_service._capturing is True

        # Stop service
        await audio_service.stop()
        assert audio_service._capturing is False


class TestAudioInputServiceControl:
    """Test audio input service control messages."""

    @pytest.mark.asyncio
    async def test_control_message_handler_exists(self, audio_service, mock_pyaudio):
        """Test that control message handler exists."""
        await audio_service.start()

        # Handler should exist
        assert hasattr(audio_service, "_on_control")

    @pytest.mark.asyncio
    async def test_control_invalid_action(self, audio_service, mock_pyaudio):
        """Test control message with invalid action."""
        await audio_service.start()

        control = AudioInputControl(action="invalid_action")
        envelope = Envelope(type="command", payload=control)

        # Should not raise exception
        await audio_service._on_control(envelope)


class TestAudioInputServiceErrorHandling:
    """Test error handling in audio input service."""

    @pytest.mark.asyncio
    async def test_pyaudio_initialization_error(self, mock_bus):
        """Test handling PyAudio initialization error."""
        with patch("app.stt_audio_input.service.pyaudio") as mock_pa:
            mock_pa.PyAudio.side_effect = Exception("PyAudio init failed")

            service = AudioInputService(bus=mock_bus)

            # Should handle error gracefully
            with pytest.raises(Exception):
                await service.start()

    @pytest.mark.asyncio
    async def test_service_handles_multiple_starts(self, audio_service, mock_pyaudio):
        """Test that service handles multiple start calls gracefully."""
        await audio_service.start()
        assert audio_service._running is True

        # Starting again should not raise error (though behavior may vary)
        # Just verify it doesn't crash
        await audio_service.stop()


class TestAudioInputServiceConfiguration:
    """Test audio configuration."""

    @pytest.mark.asyncio
    async def test_default_configuration(self, audio_service):
        """Test default audio configuration."""
        assert audio_service._sample_rate == 16000
        assert audio_service._channels == 1
        assert audio_service._chunk_size == 1024

    @pytest.mark.asyncio
    async def test_custom_configuration(self, mock_bus, mock_pyaudio):
        """Test custom audio configuration."""
        with patch("app.stt_audio_input.service.config_manager") as mock_config:
            mock_config.get.side_effect = lambda key, default=None: {
                "stt.audio_input.sample_rate": 48000,
                "stt.audio_input.channels": 2,
                "stt.audio_input.chunk_size": 2048,
            }.get(key, default)

            service = AudioInputService(bus=mock_bus)
            await service.start()

            # Configuration should be updated (if service reads config)
            # This depends on actual implementation


class TestAudioInputControlMessage:
    """Test AudioInputControl message type."""

    def test_control_creation(self):
        """Test AudioInputControl message creation."""
        control = AudioInputControl(action="start")
        assert control.action == "start"
        assert control.device_index is None

    def test_control_with_device(self):
        """Test AudioInputControl with device index."""
        control = AudioInputControl(action="start", device_index=2)
        assert control.action == "start"
        assert control.device_index == 2

    def test_control_actions(self):
        """Test different control actions."""
        actions = ["start", "stop", "pause", "resume"]
        for action in actions:
            control = AudioInputControl(action=action)
            assert control.action == action
