import os
import wave
import tempfile
import pyaudio
import subprocess
from typing import Optional
from RealtimeTTS import BaseEngine
from queue import Queue

from app.config.config_manager import config_manager
from app.helpers.getUseCuda import getUseCuda
from app.helpers.aurora_logger import log_info, log_debug, log_error, log_warning

# This is a custom PiperEngine class definition to override the default from the lib, allowing the use of voices with higher sample rates.
class PiperVoice:
    """
    Represents a Piper voice configuration.

    Args:
        model_file (str): Path to the Piper ONNX model (.onnx).
        config_file (Optional[str]): Path to the Piper JSON configuration file (.json).
                                     If not provided, it will be derived by appending ".json" to model_file.
    """
    def __init__(self, model_file: str, config_file: Optional[str] = None):
        self.model_file = model_file
        if config_file is None:
            # If the .json file exists, assume we should use it.
            possible_json = f"{model_file}.json"
            self.config_file = possible_json if os.path.isfile(possible_json) else None
        else:
            self.config_file = config_file

    def __repr__(self):
        return (
            f"PiperVoice(model_file={self.model_file}, "
            f"config_file={self.config_file})"
        )


class PiperEngine(BaseEngine):
    """
    A real-time text-to-speech engine that uses the Piper command-line tool.
    """

    def __init__(self, 
                 piper_path: Optional[str] = None, 
                 voice: Optional[PiperVoice] = None,
                 debug: bool = False):
        """
        Initializes the Piper text-to-speech engine.

        Args:
            piper_path (Optional[str]): Full path to the piper executable. 
                                        If not provided, checks the PIPER_PATH environment variable. 
                                        If that's not set, defaults to 'piper.exe'.
            voice (Optional[PiperVoice]): A PiperVoice instance with the model and optional config.
        """
        # If piper_path is None, check config manager or default to 'piper.exe'.
        if piper_path is None:
            config_path = config_manager.get("text_to_speech.piper_path", "")
            self.piper_path = config_path if config_path else "piper.exe"
        else:
            self.piper_path = piper_path

        self.voice = voice
        self.debug = debug
        self.queue = Queue()
        self.post_init()

    def post_init(self):
        self.engine_name = "piper"

    def get_stream_info(self):
        """
        Returns PyAudio stream configuration for Piper.

        Returns:
            tuple: (format, channels, rate)
        """
        return pyaudio.paInt16, 1, int(config_manager.get('text_to_speech.model_sample_rate', 24000))

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

        # Create a unique temporary WAV file.
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp_wav_file:
            output_wav_path = tmp_wav_file.name

        # Build the argument list for Piper (no shell piping).
        # If piper_path is on the PATH, you can use just "piper". Otherwise, use the full path.
        cmd_list = [
            self.piper_path,
            "-m", self.voice.model_file,
            "-f", output_wav_path
        ]
        
        # If a JSON config file is available, add it.
        if self.voice.config_file:
            cmd_list.extend(["-c", self.voice.config_file])

        # If CUDA is set for TTS
        if(getUseCuda('USE_CUDA_TTS')):
            cmd_list.extend(["--cuda"])

        # Debug: show the exact command (helpful for troubleshooting)
        if self.debug:
            log_debug(f"Running Piper with args: {cmd_list}")

        try:
            # Pass the text via STDIN directly to Piper.
            result = subprocess.run(
                cmd_list,
                input=text.encode("utf-8"),  # Piper reads from STDIN
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=True,              # Raises CalledProcessError on non-zero exit
                shell=False              # No shell means no special quoting issues
            )

            # Open the synthesized WAV file and (optionally) validate audio properties.
            with wave.open(output_wav_path, "rb") as wf:
                # If you require specific WAV properties, check them:
                if wf.getnchannels() != 1 or wf.getframerate() != int(config_manager.get('text_to_speech.model_sample_rate', 24000)) or wf.getsampwidth() != 2:
                    log_warning(f"Unexpected WAV properties: "
                        f"Channels={wf.getnchannels()}, "
                        f"Rate={wf.getframerate()}, "
                        f"Width={wf.getsampwidth()}")
                    return False

                # Read audio data and put it into the queue.
                audio_data = wf.readframes(wf.getnframes())
                self.queue.put(audio_data)

            return True

        except FileNotFoundError:
            log_error(f"Error: Piper executable not found at '{self.piper_path}'.")
            return False
        except subprocess.CalledProcessError as e:
            # Piper returned an error code; show the stderr output for troubleshooting.
            log_error(f"Error running Piper: {e.stderr.decode('utf-8', errors='replace')}")
            return False
        finally:
            # Clean up the temporary WAV file after reading it.
            if os.path.isfile(output_wav_path):
                os.remove(output_wav_path)

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
