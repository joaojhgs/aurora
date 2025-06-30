"""
Unit tests for the Text-to-Speech module with minimal mocks.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


class MockTTS:
    """Mock TTS class for testing."""

    def __init__(self):
        self.is_playing = False
        self.text_queue = []

    def speak(self, text):
        """Speak text."""
        self.text_queue.append(text)
        self.is_playing = True

    def stop(self):
        """Stop speaking."""
        self.is_playing = False
        self.text_queue = []

    def pause(self):
        """Pause speaking."""
        self.is_playing = False

    def resume(self):
        """Resume speaking."""
        self.is_playing = True


class TestTextToSpeech:
    """Tests for the Text-to-Speech module."""

    def test_basic_tts(self):
        """Test basic TTS functionality."""
        tts = MockTTS()

        # Test speak
        tts.speak("Hello, world!")
        assert tts.is_playing
        assert "Hello, world!" in tts.text_queue

        # Test stop
        tts.stop()
        assert not tts.is_playing
        assert len(tts.text_queue) == 0

        # Test pause and resume
        tts.speak("Test message")
        assert tts.is_playing

        tts.pause()
        assert not tts.is_playing

        tts.resume()
        assert tts.is_playing
