from RealtimeTTS import TextToAudioStream, PiperVoice
from modules.text_to_speech.piper_engine import PiperEngine
import os

file_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def get_voice():
    model_file = file_root + os.getenv('TTS_MODEL_FILE_PATH', '/voice_models/en_US-lessac-medium.onnx')
    config_file = file_root + os.getenv('TTS_MODEL_CONFIG_FILE_PATH', '/voice_models/en_US-lessac-medium.onnx.txt')
    return PiperVoice(model_file=model_file, config_file=config_file)

voice = get_voice()
engine = PiperEngine(piper_path="piper", voice=voice)
stream = TextToAudioStream(engine, frames_per_buffer=256)

def play(text):
    # Stop any async audio and clears any text that was in queue
    stream.stop()
    stream.feed(text)
    stream.play_async()

def stop():
    stream.stop()

def pause():
    # Pauses allowing it to resume later
    stream.pause()

def resume():
    # Resume speaking previous text
    stream.resume()