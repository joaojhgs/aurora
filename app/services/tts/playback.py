"""Local TTS playback construction."""

from __future__ import annotations

import contextlib
import importlib
import queue
import threading
import time
from collections.abc import Callable
from types import ModuleType
from typing import Any, Protocol

from app.helpers.aurora_logger import log_debug, log_warning


class ServerPlayback(Protocol):
    """Small service-facing playback surface."""

    supports_text_feed: bool
    supports_pcm: bool

    def stop(self) -> None:
        """Stop local playback."""

    def pause(self) -> None:
        """Pause local playback."""

    def resume(self) -> None:
        """Resume local playback."""


class TextServerPlayback:
    """Adapter around the RealtimeTTS text stream."""

    supports_text_feed = True
    supports_pcm = False

    def __init__(self, stream) -> None:  # type: ignore[no-untyped-def]
        self._stream = stream

    def feed(self, text: str) -> None:
        """Feed text to the wrapped playback stream."""
        self._stream.feed(text)

    def play_async(self) -> None:
        """Start the wrapped playback stream."""
        self._stream.play_async()

    def stop(self) -> None:
        """Stop the wrapped playback stream."""
        self._stream.stop()

    def pause(self) -> None:
        """Pause the wrapped playback stream."""
        self._stream.pause()

    def resume(self) -> None:
        """Resume the wrapped playback stream."""
        self._stream.resume()


class PCMServerPlayback:
    """Provider-neutral PCM playback controller with optional PyAudio output."""

    supports_text_feed = False
    supports_pcm = True

    def __init__(
        self,
        *,
        on_audio_stream_start: Callable[[], None],
        on_audio_stream_stop: Callable[[], None],
        frames_per_buffer: int = 1024,
    ) -> None:
        self._on_audio_stream_start = on_audio_stream_start
        self._on_audio_stream_stop = on_audio_stream_stop
        self._frames_per_buffer = max(1, frames_per_buffer)
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._pause_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._queue: queue.Queue[tuple[bytes, int]] = queue.Queue()
        self._pyaudio: ModuleType | None = None
        self._audio: Any | None = None
        self._pyaudio_unavailable = False
        self._warned_unavailable = False

    def play_pcm_async(self, audio: bytes, *, sample_rate: int) -> None:
        """Queue raw 16-bit mono PCM bytes for asynchronous playback."""
        if self._ensure_pyaudio() is None:
            raise RuntimeError("TTS audio output unavailable")
        with self._lock:
            self._queue.put((bytes(audio), int(sample_rate)))
            if self._thread is None or not self._thread.is_alive():
                self._stop_event.clear()
                self._pause_event.clear()
                self._thread = threading.Thread(
                    target=self._play_queue,
                    name="aurora-tts-pcm-playback",
                    daemon=True,
                )
                self._thread.start()

    def stop(self) -> None:
        """Stop current PCM playback."""
        with self._lock:
            thread = self._thread
            self._thread = None
            self._stop_event.set()
            self._pause_event.clear()
            while True:
                try:
                    self._queue.get_nowait()
                except queue.Empty:
                    break
        if thread is not None and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=0.5)

    def pause(self) -> None:
        """Pause current PCM playback."""
        self._pause_event.set()

    def resume(self) -> None:
        """Resume current PCM playback."""
        self._pause_event.clear()

    def close(self) -> None:
        """Release optional PyAudio resources."""
        self.stop()
        if self._audio is not None:
            with contextlib.suppress(Exception):
                self._audio.terminate()
        self._audio = None
        self._pyaudio = None

    def _ensure_pyaudio(self) -> ModuleType | None:
        if self._pyaudio is not None:
            return self._pyaudio
        if self._pyaudio_unavailable:
            return None
        try:
            module = importlib.import_module("pyaudio")
        except Exception:
            if not self._warned_unavailable:
                log_warning("PyAudio is unavailable; TTS server audio output is disabled")
                self._warned_unavailable = True
            self._pyaudio_unavailable = True
            return None
        self._audio = module.PyAudio()
        self._pyaudio = module
        return module

    def _play_queue(self) -> None:
        self._on_audio_stream_start()
        stop_callback_sent = False
        try:
            while not self._stop_event.is_set():
                try:
                    item = self._queue.get(timeout=0.05)
                except queue.Empty:
                    with self._lock:
                        if self._queue.empty():
                            self._on_audio_stream_stop()
                            stop_callback_sent = True
                            if self._thread is threading.current_thread():
                                self._thread = None
                            return
                    continue
                pyaudio = self._ensure_pyaudio()
                if pyaudio is None:
                    raise RuntimeError("TTS audio output unavailable")
                if self._audio is None:
                    raise RuntimeError("TTS audio output unavailable")
                self._play_pcm_item(self._audio, pyaudio, item[0], item[1])
        except Exception as exc:
            log_debug(f"TTS PCM playback failure type={type(exc).__name__}")
        finally:
            if not stop_callback_sent:
                with self._lock:
                    self._on_audio_stream_stop()
                    if self._thread is threading.current_thread():
                        self._thread = None

    def _play_pcm_item(
        self, audio_output: Any, pyaudio: ModuleType, audio: bytes, sample_rate: int
    ) -> None:
        stream = audio_output.open(
            format=pyaudio.paInt16,
            channels=1,
            rate=sample_rate,
            output=True,
            frames_per_buffer=self._frames_per_buffer,
        )
        try:
            width = self._frames_per_buffer * 2
            for offset in range(0, len(audio), width):
                if self._stop_event.is_set():
                    break
                while self._pause_event.is_set() and not self._stop_event.is_set():
                    time.sleep(0.01)
                if self._stop_event.is_set():
                    break
                stream.write(audio[offset : offset + width])
        finally:
            with contextlib.suppress(Exception):
                stream.stop_stream()
            with contextlib.suppress(Exception):
                stream.close()


def create_realtime_piper_stream(
    *,
    piper_path: str,
    model_file: str,
    config_file: str | None,
    sample_rate: int,
    on_audio_stream_start: Callable[[], None],
    on_audio_stream_stop: Callable[[], None],
) -> tuple[object, TextServerPlayback]:
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
    return engine, TextServerPlayback(stream)


def create_pcm_playback(
    *,
    on_audio_stream_start: Callable[[], None],
    on_audio_stream_stop: Callable[[], None],
) -> PCMServerPlayback:
    """Create provider-neutral PCM playback for local server audio."""
    return PCMServerPlayback(
        on_audio_stream_start=on_audio_stream_start,
        on_audio_stream_stop=on_audio_stream_stop,
    )
