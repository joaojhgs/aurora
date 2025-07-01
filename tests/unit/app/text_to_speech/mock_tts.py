"""
Basic TTS wrapper for testing
"""


class TextToAudioStream:
    """Mock TextToAudioStream for testing."""

    def __init__(self, engine, frames_per_buffer=1024, on_audio_stream_start=None, on_audio_stream_stop=None):
        self.engine = engine
        self.frames_per_buffer = frames_per_buffer
        self.on_audio_stream_start = on_audio_stream_start
        self.on_audio_stream_stop = on_audio_stream_stop
        self.is_playing = False
        self.is_paused = False
        self.text_queue = []

    def feed(self, text):
        """Add text to the queue."""
        self.text_queue.append(text)

    def play_async(self):
        """Start playing text asynchronously."""
        if self.on_audio_stream_start:
            self.on_audio_stream_start()
        self.is_playing = True

    def stop(self):
        """Stop playing and clear queue."""
        if self.is_playing and self.on_audio_stream_stop:
            self.on_audio_stream_stop()
        self.is_playing = False
        self.is_paused = False
        self.text_queue = []

    def pause(self):
        """Pause playback."""
        self.is_paused = True

    def resume(self):
        """Resume playback."""
        self.is_paused = False
        self.is_playing = True


class PiperVoice:
    """Mock PiperVoice for testing."""

    def __init__(self, model_file, config_file):
        self.model_file = model_file
        self.config_file = config_file


class PiperEngine:
    """Mock PiperEngine for testing."""

    def __init__(self, piper_path, voice):
        self.piper_path = piper_path
        self.voice = voice


# Mock stream instance
voice = PiperVoice(model_file="/path/to/model.onnx", config_file="/path/to/config.txt")
engine = PiperEngine(piper_path="piper", voice=voice)
stream = TextToAudioStream(engine, frames_per_buffer=256)


# TTS functions
def play(text):
    """Play text through TTS."""
    stream.stop()
    stream.feed(text)
    stream.play_async()


def stop():
    """Stop TTS playback."""
    stream.stop()


def pause():
    """Pause TTS playback."""
    stream.pause()


def resume():
    """Resume TTS playback."""
    stream.resume()


class TTS:
    """Mock TTS class for testing."""

    def __init__(self, config=None):
        """Initialize TTS module."""
        self.voice = voice
        self.engine = engine
        self.stream = stream

    def speak(self, text):
        """Speak text."""
        play(text)

    def stop(self):
        """Stop speaking."""
        stop()

    def pause(self):
        """Pause speaking."""
        pause()

    def resume(self):
        """Resume speaking."""
        resume()
