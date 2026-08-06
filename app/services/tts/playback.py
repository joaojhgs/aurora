"""Local TTS playback construction."""

from __future__ import annotations

from collections.abc import Callable


def create_realtime_piper_stream(
    *,
    piper_path: str,
    model_file: str,
    config_file: str | None,
    sample_rate: int,
    on_audio_stream_start: Callable[[], None],
    on_audio_stream_stop: Callable[[], None],
):
    """Create the RealtimeTTS stream used for local server playback."""
    from RealtimeTTS import PiperVoice, TextToAudioStream

    from app.services.tts.piper_engine import PiperEngine

    voice = PiperVoice(model_file=model_file, config_file=config_file)
    engine = PiperEngine(piper_path=piper_path, voice=voice, sample_rate=sample_rate)
    stream = TextToAudioStream(
        engine,
        frames_per_buffer=256,
        on_audio_stream_start=on_audio_stream_start,
        on_audio_stream_stop=on_audio_stream_stop,
    )
    return engine, stream
