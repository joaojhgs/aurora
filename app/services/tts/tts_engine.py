import asyncio
import os

from RealtimeTTS import PiperVoice, TextToAudioStream

from app.services.tts.piper_engine import PiperEngine
from app.services.tts.service import reduce_volume_except_current, restore_volume_except_current
from app.shared.config.interface import ConfigAPI
from app.shared.config.keys import ConfigKeys
from app.shared.config.models import Tts
from app.shared.path_utils import get_project_root

config_api = ConfigAPI()

file_root = get_project_root()

# Lazy-initialized singletons
_voice: PiperVoice | None = None
_engine: PiperEngine | None = None
_stream: TextToAudioStream | None = None
_init_lock = asyncio.Lock()


def on_audio_stream_start():
    reduce_volume_except_current()


def on_audio_stream_stop():
    # Restore the system volume when the audio stream stops
    restore_volume_except_current()


def get_voice_sync() -> PiperVoice:
    """Get voice synchronously using default values.

    This is a fallback for sync contexts. Prefer async_get_voice() when possible.
    """
    from app.shared.path_utils import resolve_path

    model_file_path = "voice_models/en_US-lessac-medium.onnx"
    config_file_path = "voice_models/en_US-lessac-medium.onnx.txt"
    model_file = str(resolve_path(model_file_path))
    config_file = str(resolve_path(config_file_path)) if config_file_path else None
    return PiperVoice(model_file=model_file, config_file=config_file)


async def async_get_voice() -> PiperVoice:
    """Get voice configuration asynchronously from config service.

    Uses await config_api.aget(ConfigKeys.services.tts, Tts) to load validated TTS config.
    """
    from app.shared.path_utils import resolve_path

    tts_cfg = await config_api.aget(ConfigKeys.services.tts, Tts)
    model_file_path = tts_cfg.model_file_path or "voice_models/en_US-lessac-medium.onnx"
    config_file_path = tts_cfg.model_config_file_path or "voice_models/en_US-lessac-medium.onnx.txt"
    model_file = str(resolve_path(model_file_path))
    config_file = str(resolve_path(config_file_path)) if config_file_path else None
    return PiperVoice(model_file=model_file, config_file=config_file)


async def get_engine() -> PiperEngine:
    """Get or create the PiperEngine singleton asynchronously.

    Uses async initialization to properly load config from ConfigService.
    Thread-safe via asyncio.Lock.
    """
    global _engine, _voice
    async with _init_lock:
        if _engine is None:
            _voice = await async_get_voice()
            _engine = PiperEngine(piper_path="piper", voice=_voice)
        return _engine


async def get_stream() -> TextToAudioStream:
    """Get or create the TextToAudioStream singleton asynchronously.

    Ensures engine is initialized first via get_engine().
    Thread-safe via asyncio.Lock.
    """
    global _stream
    async with _init_lock:
        if _stream is None:
            engine = await get_engine()
            _stream = TextToAudioStream(
                engine,
                frames_per_buffer=256,
                on_audio_stream_start=on_audio_stream_start,
                on_audio_stream_stop=on_audio_stream_stop,
            )
        return _stream


def get_stream_sync() -> TextToAudioStream:
    """Get stream synchronously, initializing with defaults if needed.

    This is a fallback for sync contexts where async initialization isn't possible.
    Prefer get_stream() in async contexts for proper config loading.
    """
    global _stream, _engine, _voice
    if _stream is None:
        if _voice is None:
            _voice = get_voice_sync()
        if _engine is None:
            _engine = PiperEngine(piper_path="piper", voice=_voice)
        _stream = TextToAudioStream(
            _engine,
            frames_per_buffer=256,
            on_audio_stream_start=on_audio_stream_start,
            on_audio_stream_stop=on_audio_stream_stop,
        )
    return _stream


async def play_async(text):
    """Play text asynchronously with proper async initialization."""
    stream = await get_stream()
    stream.stop()
    stream.feed(text)
    stream.play_async()


def play(text):
    """Play text synchronously (uses sync fallback for stream initialization)."""
    stream = get_stream_sync()
    stream.stop()
    stream.feed(text)
    stream.play_async()


async def stop_async():
    """Stop audio asynchronously."""
    stream = await get_stream()
    stream.stop()


def stop():
    """Stop audio synchronously."""
    stream = get_stream_sync()
    stream.stop()


async def pause_async():
    """Pause audio asynchronously."""
    stream = await get_stream()
    stream.pause()


def pause():
    """Pause audio synchronously, allowing resume later."""
    stream = get_stream_sync()
    stream.pause()


async def resume_async():
    """Resume audio asynchronously."""
    stream = await get_stream()
    stream.resume()


def resume():
    """Resume speaking previous text synchronously."""
    stream = get_stream_sync()
    stream.resume()
