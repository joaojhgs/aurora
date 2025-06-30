import os

from RealtimeTTS import PiperVoice, TextToAudioStream

from app.config.config_manager import config_manager
from app.speech_to_text.stt import reduce_volume_except_current, restore_volume_except_current
from app.text_to_speech.piper_engine import PiperEngine

file_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def on_audio_stream_start():
    reduce_volume_except_current()


def on_audio_stream_stop():
    # Restore the system volume when the audio stream stops
    restore_volume_except_current()


def get_voice():
    model_file = file_root + config_manager.get(
        "text_to_speech.model_file_path", "/voice_models/en_US-lessac-medium.onnx"
    )
    config_file = file_root + config_manager.get(
        "text_to_speech.model_config_file_path", "/voice_models/en_US-lessac-medium.onnx.txt"
    )
    return PiperVoice(model_file=model_file, config_file=config_file)


voice = get_voice()
engine = PiperEngine(piper_path="piper", voice=voice)

stream = TextToAudioStream(
    engine,
    frames_per_buffer=256,
    on_audio_stream_start=on_audio_stream_start,
    on_audio_stream_stop=on_audio_stream_stop,
)


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
