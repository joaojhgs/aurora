from RealtimeTTS import TextToAudioStream, PiperEngine, PiperVoice
import os

file_root = os.path.dirname(os.path.abspath(__file__))

voice = PiperVoice(
    model_file=file_root + "/voice_models/pt_BR-faber-medium.onnx",
    config_file=file_root + "/voice_models/pt_BR-faber-medium.onnx.txt",
)

engine = PiperEngine(piper_path="piper", voice=voice)
stream = TextToAudioStream(engine, frames_per_buffer=256)

def play (text):
    stream.feed(text)
    stream.play_async()