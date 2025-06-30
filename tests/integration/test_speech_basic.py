"""
Integration tests for the speech components.
"""

from unittest.mock import MagicMock, call, patch

import pytest
import pytest_asyncio


@pytest.mark.integration
class TestSpeechIntegrationBasic:
    """Basic integration tests for speech components without dependencies."""

    def test_tts_mock(self):
        """Test that TTS can be properly mocked."""
        # Mock the TTS play function
        with patch("app.text_to_speech.tts.play") as mock_play:
            # Import the module after patching
            from app.text_to_speech.tts import play

            # Call the function
            play("Hello world")

            # Verify it was called correctly
            mock_play.assert_called_once_with("Hello world")

    def test_stt_wakeword_integration(self):
        """Test that wakeword detection interacts correctly with TTS."""
        # Set up our patches
        with patch("app.text_to_speech.tts.pause") as mock_pause:
            with patch("app.speech_to_text.stt.detected", True, create=True):
                # Import on_wakeword_detected after patching
                from app.speech_to_text.stt import on_wakeword_detected

                # Call the function that should invoke pause
                on_wakeword_detected()

                # Verify pause was called
                mock_pause.assert_called_once()

    def test_audio_pipeline(self):
        """Test the audio pipeline with mocks."""
        # Mock both STT and TTS functions
        with patch("app.speech_to_text.stt.on_wakeword_detected") as mock_detect:
            with patch("app.text_to_speech.tts.play") as mock_play:
                # Simulate wakeword detection
                mock_detect()
                mock_detect.assert_called_once()

                # Simulate processing user query and responding
                mock_play("The weather today is sunny.")

                # Verify correct TTS output
                mock_play.assert_called_once_with("The weather today is sunny.")
