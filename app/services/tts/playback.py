"""Local TTS playback construction."""

from __future__ import annotations

import contextlib
import importlib
import queue
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from types import ModuleType
from typing import Any, Protocol

from app.helpers.aurora_logger import log_debug, log_warning


@dataclass
class _PCMWorker:
    generation: int
    playback_id: int | None
    work_queue: queue.Queue[tuple[bytes, int]]
    stop_event: threading.Event
    thread: threading.Thread


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
        on_audio_stream_error: Callable[..., None] | None = None,
        frames_per_buffer: int = 1024,
    ) -> None:
        self._on_audio_stream_start = on_audio_stream_start
        self._on_audio_stream_stop = on_audio_stream_stop
        self._on_audio_stream_error = on_audio_stream_error
        self._frames_per_buffer = max(1, frames_per_buffer)
        self._lock = threading.Lock()
        self._pause_event = threading.Event()
        self._generation = 0
        self._worker: _PCMWorker | None = None
        self._pyaudio: ModuleType | None = None
        self._audio: Any | None = None
        self._pyaudio_unavailable = False
        self._warned_unavailable = False

    def play_pcm_async(
        self, audio: bytes, *, sample_rate: int, playback_id: int | None = None
    ) -> None:
        """Queue raw 16-bit mono PCM bytes for asynchronous playback."""
        if isinstance(sample_rate, bool) or not isinstance(sample_rate, int) or sample_rate <= 0:
            raise RuntimeError("TTS audio output unavailable")
        if self._ensure_pyaudio() is None:
            raise RuntimeError("TTS audio output unavailable")
        with self._lock:
            worker = self._worker
            if worker is None or not worker.thread.is_alive() or worker.stop_event.is_set():
                self._generation += 1
                self._pause_event.clear()
                work_queue: queue.Queue[tuple[bytes, int]] = queue.Queue()
                stop_event = threading.Event()
                generation = self._generation
                thread = threading.Thread(
                    target=self._play_queue,
                    args=(generation, playback_id, work_queue, stop_event),
                    name="aurora-tts-pcm-playback",
                    daemon=True,
                )
                worker = _PCMWorker(
                    generation=generation,
                    playback_id=playback_id,
                    work_queue=work_queue,
                    stop_event=stop_event,
                    thread=thread,
                )
                self._worker = worker
                thread.start()
            worker.work_queue.put((bytes(audio), int(sample_rate)))

    def stop(self) -> None:
        """Stop current PCM playback."""
        with self._lock:
            worker = self._worker
            self._worker = None
            self._pause_event.clear()
            if worker is None:
                return
            worker.stop_event.set()
            while True:
                try:
                    worker.work_queue.get_nowait()
                except queue.Empty:
                    break
        if worker.thread.is_alive() and worker.thread is not threading.current_thread():
            worker.thread.join(timeout=0.5)

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

    def _invoke_callback(self, callback: Callable[..., None], playback_id: int | None) -> None:
        try:
            callback(playback_id)
        except TypeError:
            callback()

    def _play_queue(
        self,
        generation: int,
        playback_id: int | None,
        work_queue: queue.Queue[tuple[bytes, int]],
        stop_event: threading.Event,
    ) -> None:
        self._invoke_callback(self._on_audio_stream_start, playback_id)
        stop_callback_sent = False
        try:
            while not stop_event.is_set() and self._is_active_generation(generation):
                try:
                    item = work_queue.get(timeout=0.05)
                except queue.Empty:
                    with self._lock:
                        if work_queue.empty() and self._is_active_generation(generation):
                            self._invoke_callback(self._on_audio_stream_stop, playback_id)
                            stop_callback_sent = True
                            self._worker = None
                            return
                    continue
                pyaudio = self._ensure_pyaudio()
                if pyaudio is None:
                    raise RuntimeError("TTS audio output unavailable")
                if self._audio is None:
                    raise RuntimeError("TTS audio output unavailable")
                self._play_pcm_item(self._audio, pyaudio, item[0], item[1], generation, stop_event)
        except Exception as exc:
            log_debug(f"TTS PCM playback failure type={type(exc).__name__}")
            if self._on_audio_stream_error is not None and self._is_active_generation(generation):
                self._invoke_error_callback(playback_id, exc)
        finally:
            if not stop_callback_sent:
                with self._lock:
                    self._invoke_callback(self._on_audio_stream_stop, playback_id)
                    if self._is_active_generation(generation):
                        self._worker = None

    def _is_active_generation(self, generation: int) -> bool:
        worker = self._worker
        return worker is not None and worker.generation == generation

    def _invoke_error_callback(self, playback_id: int | None, exc: Exception) -> None:
        if self._on_audio_stream_error is None:
            return
        try:
            self._on_audio_stream_error(playback_id, exc)
        except TypeError:
            self._on_audio_stream_error(exc)

    def _play_pcm_item(
        self,
        audio_output: Any,
        pyaudio: ModuleType,
        audio: bytes,
        sample_rate: int,
        generation: int,
        stop_event: threading.Event,
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
                if stop_event.is_set() or not self._is_active_generation(generation):
                    break
                while (
                    self._pause_event.is_set()
                    and not stop_event.is_set()
                    and self._is_active_generation(generation)
                ):
                    time.sleep(0.01)
                if stop_event.is_set() or not self._is_active_generation(generation):
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
    on_audio_stream_error: Callable[..., None] | None = None,
) -> PCMServerPlayback:
    """Create provider-neutral PCM playback for local server audio."""
    return PCMServerPlayback(
        on_audio_stream_start=on_audio_stream_start,
        on_audio_stream_stop=on_audio_stream_stop,
        on_audio_stream_error=on_audio_stream_error,
    )
