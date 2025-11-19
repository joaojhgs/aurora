import os

from RealtimeTTS import PiperVoice, TextToAudioStream

from app.config.config_manager import config_manager
from app.speech_to_text.stt import reduce_volume_except_current, restore_volume_except_current
from app.text_to_speech.piper_engine import PiperEngine

file_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def on_audio_stream_start():
    import asyncio

    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            asyncio.create_task(reduce_volume_except_current())
        else:
            asyncio.run(reduce_volume_except_current())
    except Exception:
        pass  # Fail silently if async operations not available


def on_audio_stream_stop():
    # Restore the system volume when the audio stream stops
    import asyncio

    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            asyncio.create_task(restore_volume_except_current())
        else:
            asyncio.run(restore_volume_except_current())
    except Exception:
        pass  # Fail silently if async operations not available


def get_voice():
    model_file = file_root + config_manager.get("general.text_to_speech.model_file_path", "/voice_models/en_US-lessac-medium.onnx")
    config_file = file_root + config_manager.get("general.text_to_speech.model_config_file_path", "/voice_models/en_US-lessac-medium.onnx.txt")
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
