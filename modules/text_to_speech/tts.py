from RealtimeTTS import TextToAudioStream, PiperVoice
from modules.text_to_speech.piper_engine import PiperEngine
import os

file_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

voice = PiperVoice(
    model_file=file_root + "/voice_models/pt_BR-faber-medium.onnx",
    config_file=file_root + "/voice_models/pt_BR-faber-medium.onnx.txt",
)

engine = PiperEngine(piper_path="piper", voice=voice)
stream = TextToAudioStream(engine, frames_per_buffer=256)

def play (text):
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