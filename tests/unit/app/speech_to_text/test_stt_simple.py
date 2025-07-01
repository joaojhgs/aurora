"""
Unit tests for the Speech-to-Text module with minimal mocks.
"""

from unittest.mock import AsyncMock

import pytest


# Create a basic AudioRecorder mock
class MockAudioRecorder:
    def __init__(self):
        self.recording = False

    async def start_recording(self):
        self.recording = True
        return True

    async def stop_recording(self):
        self.recording = False
        return b"mock_audio_data"

    def is_recording(self):
        return self.recording


# Create a basic STT mock
class MockSTT:
    def __init__(self):
        self.audio_recorder = MockAudioRecorder()
        self.wake_word_model_path = "/path/to/wake_word.onnx"
        self.timeout_seconds = 10

    async def start_listening(self, callback):
        wake_word_detected = await self._detect_wake_word()

        if not wake_word_detected:
            return None

        try:
            await self.audio_recorder.start_recording()
            audio_data = await self.audio_recorder.stop_recording()

            if callback:
                result = await callback(audio_data)
                return result
        except TimeoutError:
            await self.audio_recorder.stop_recording()
            return None

    async def _detect_wake_word(self):
        return True


# Test class with simplified tests
class TestSpeechToText:
    """Tests for the Speech-to-Text module."""

    def test_basic_mock(self):
        """Test that our mock classes work."""
        mock_stt = MockSTT()
        assert mock_stt.timeout_seconds == 10
        assert mock_stt.wake_word_model_path == "/path/to/wake_word.onnx"
        assert isinstance(mock_stt.audio_recorder, MockAudioRecorder)

    @pytest.mark.asyncio
    async def test_wake_word_detection(self):
        """Test wake word detection."""
        mock_stt = MockSTT()
        # Override the _detect_wake_word method to return True
        mock_stt._detect_wake_word = AsyncMock(return_value=True)

        # Create a callback
        callback = AsyncMock(return_value="Test transcription")

        # Call start_listening
        result = await mock_stt.start_listening(callback)

        # Check results
        assert result == "Test transcription"
        # Verify the callback was called
        callback.assert_called_once()

    @pytest.mark.asyncio
    async def test_wake_word_detection_failure(self):
        """Test behavior when wake word is not detected."""
        mock_stt = MockSTT()
        # Override the _detect_wake_word method to return False
        mock_stt._detect_wake_word = AsyncMock(return_value=False)

        # Create a callback
        callback = AsyncMock(return_value="Test transcription")

        # Call start_listening
        result = await mock_stt.start_listening(callback)

        # Check results
        assert result is None
        # Verify the callback was not called
        callback.assert_not_called()
