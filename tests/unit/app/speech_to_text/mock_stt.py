"""
Basic STT wrapper for testing
"""


class AudioRecorder:
    """Mock AudioRecorder for testing."""

    def __init__(self):
        self.recording = False

    async def start_recording(self):
        """Start recording audio."""
        self.recording = True
        return True

    async def stop_recording(self):
        """Stop recording audio."""
        self.recording = False
        return b"mock_audio_data"

    def is_recording(self):
        """Check if recording is active."""
        return self.recording


class STT:
    """Basic STT class for testing."""

    def __init__(self):
        self.audio_recorder = AudioRecorder()
        self.wake_word_model_path = "/path/to/wake_word.onnx"
        self.timeout_seconds = 10

    async def start_listening(self, callback):
        """Start listening for wake word and then speech."""
        # First detect wake word
        wake_word_detected = await self._detect_wake_word()

        if not wake_word_detected:
            return None

        try:
            # Start recording
            await self.audio_recorder.start_recording()

            # Get audio data
            audio_data = await self.audio_recorder.stop_recording()

            # Process with callback
            if callback:
                result = await callback(audio_data)
                return result

        except TimeoutError:
            # Handle timeout
            await self.audio_recorder.stop_recording()
            return None

    async def _detect_wake_word(self):
        """Simulate wake word detection."""
        return True
