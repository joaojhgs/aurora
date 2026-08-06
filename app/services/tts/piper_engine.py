import os
from queue import Queue

import pyaudio
from RealtimeTTS import BaseEngine

from app.helpers.aurora_logger import log_error
from app.services.tts.providers.piper import (
    PiperVoiceConfig,
    synthesize_piper_cli,
)


# This is a custom PiperEngine class definition to override the default
# from the lib, allowing the use of voices with higher sample rates.
class PiperVoice:
    """
    Represents a Piper voice configuration.

    Args:
        model_file (str): Path to the Piper ONNX model (.onnx).
        config_file (Optional[str]): Path to the Piper JSON configuration file (.json).
                                     If not provided, it will be derived by appending ".json" to model_file.
    """

    def __init__(self, model_file: str, config_file: str | None = None):
        self.model_file = model_file
        if config_file is None:
            # If the .json file exists, assume we should use it.
            possible_json = f"{model_file}.json"
            self.config_file = possible_json if os.path.isfile(possible_json) else None
        else:
            self.config_file = config_file

    def __repr__(self):
        return f"PiperVoice(model_file={self.model_file}, config_file={self.config_file})"


class PiperEngine(BaseEngine):
    """
    A real-time text-to-speech engine that uses the Piper command-line tool.
    """

    def __init__(
        self,
        piper_path: str | None = None,
        voice: PiperVoice | None = None,
        debug: bool = False,
        sample_rate: int | None = None,
    ):
        """
        Initializes the Piper text-to-speech engine.

        Args:
            piper_path (Optional[str]): Full path to the piper executable.
                                        If not provided, checks the PIPER_PATH environment variable.
                                        If that's not set, defaults to 'piper.exe'.
            voice (Optional[PiperVoice]): A PiperVoice instance with the model and optional config.
            debug (bool): Enable debug logging.
            sample_rate (Optional[int]): Sample rate for audio stream. If None, will be loaded from config.
        """
        # If piper_path is None, check environment variable or default to 'piper'.
        if piper_path is None:
            import os

            env_path = os.getenv("AURORA_PIPER_PATH")
            self.piper_path = env_path if env_path else "piper"
        else:
            self.piper_path = piper_path

        self.voice = voice
        self.debug = debug
        self.queue = Queue()

        # Cache sample rate to avoid repeated config requests during playback
        if sample_rate is None:
            import os

            # Use environment variable or default
            env_rate = os.getenv("AURORA_TTS_SAMPLE_RATE")
            self._sample_rate = int(env_rate) if env_rate else 24000
        else:
            self._sample_rate = sample_rate

        # Cache hardware acceleration setting using environment variables (no config requests)
        from app.helpers.getUseHardwareAcceleration import get_use_hardware_acceleration

        self._use_cuda = get_use_hardware_acceleration("tts")

        self.post_init()

    def post_init(self):
        self.engine_name = "piper"

    def get_stream_info(self):
        """
        Returns PyAudio stream configuration for Piper.

        Returns:
            tuple: (format, channels, rate)
        """
        return (
            pyaudio.paInt16,
            1,
            self._sample_rate,
        )

    def synthesize(self, text: str) -> bool:
        """
        Synthesizes text into audio data using Piper.

        Args:
            text (str): The text to be converted to speech.

        Returns:
            bool: True if successful, False otherwise.
        """
        if not self.voice:
            log_error("No voice set. Please provide a PiperVoice configuration.")
            return False

        try:
            audio_data, sample_rate = synthesize_piper_cli(
                piper_path=self.piper_path,
                voice=PiperVoiceConfig(
                    voice_id="active",
                    model_file=self.voice.model_file,
                    config_file=self.voice.config_file,
                ),
                text=text,
                use_cuda=self._use_cuda == "cuda",
                debug=self.debug,
            )
            if sample_rate != self._sample_rate:
                log_error(
                    f"Unexpected Piper sample rate: expected={self._sample_rate}, actual={sample_rate}"
                )
                return False
            self.queue.put(audio_data)
            return True

        except Exception as e:
            log_error(str(e))
            return False

    def set_voice(self, voice: PiperVoice):
        """
        Sets the Piper voice to be used for speech synthesis.

        Args:
            voice (PiperVoice): The voice configuration.
        """
        self.voice = voice

    def get_voices(self):
        """
        Piper doesn't provide a way to list available voices in the same sense as other engines.
        This method returns an empty list.

        Returns:
            list: Empty list.
        """
        return []
