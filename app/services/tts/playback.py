"""Local TTS playback construction."""

from __future__ import annotations

import contextlib
import importlib
import queue
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from types import ModuleType
from typing import Any, Protocol

from app.helpers.aurora_logger import log_debug, log_warning

_MAX_QUEUED_PCM_CHUNKS = 8
_PCM_ENQUEUE_TIMEOUT_SECONDS = 1.0


@dataclass
class _PCMWorker:
    generation: int
    playback_id: int | None
    work_queue: queue.Queue[tuple[bytes, int]]
    stop_event: threading.Event
    thread: threading.Thread
    pending_writes: int = 0
    completion: threading.Event = field(default_factory=threading.Event)
    completion_result: str | None = None
    failure: Exception | None = None


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
        self._enqueue_lock = threading.Lock()
        self._stop_lock = threading.Lock()
        self._pause_event = threading.Event()
        self._generation = 0
        self._admission_epoch = 0
        self._stopping = False
        self._worker: _PCMWorker | None = None
        self._pyaudio: ModuleType | None = None
        self._audio: Any | None = None
        self._pyaudio_unavailable = False
        self._warned_unavailable = False

    def play_pcm_async(
        self, audio: bytes, *, sample_rate: int, playback_id: int | None = None
    ) -> None:
        """Queue raw PCM for playback, applying bounded producer backpressure.

        The TTS service invokes this blocking enqueue operation in a worker
        thread. Audio is split into device-sized chunks and accepted only while
        the current worker can drain it; a stopped or failed worker makes the
        enqueue fail visibly instead of silently losing the remainder.
        """
        if isinstance(sample_rate, bool) or not isinstance(sample_rate, int) or sample_rate <= 0:
            raise RuntimeError("TTS audio output unavailable")

        with self._lock:
            if self._stopping:
                raise RuntimeError("TTS audio output unavailable")
            admission_epoch = self._admission_epoch
        with self._enqueue_lock:
            with self._lock:
                if self._stopping or admission_epoch != self._admission_epoch:
                    raise RuntimeError("TTS audio output unavailable")
            self._enqueue_pcm(audio, sample_rate, playback_id, admission_epoch)

    def _enqueue_pcm(
        self,
        audio: bytes,
        sample_rate: int,
        playback_id: int | None,
        admission_epoch: int,
    ) -> None:
        pcm = bytes(audio)
        chunk_size = self._frames_per_buffer * 2
        if self._ensure_pyaudio() is None:
            raise RuntimeError("TTS audio output unavailable")

        finishing_worker: _PCMWorker | None = None
        with self._lock:
            if self._stopping or admission_epoch != self._admission_epoch:
                raise RuntimeError("TTS audio output unavailable")
            worker = self._worker
            if worker is not None and worker.thread.is_alive():
                if not worker.stop_event.is_set() and worker.failure is None:
                    worker.pending_writes += 1
                    enqueue_worker = worker
                else:
                    finishing_worker = worker
            elif worker is not None:
                self._worker = None
                worker = None
            else:
                worker = None

        if finishing_worker is not None:
            finishing_worker.thread.join(timeout=0.5)
            if finishing_worker.thread.is_alive():
                raise RuntimeError("TTS audio output unavailable")

        if finishing_worker is None and worker is not None:
            enqueue_worker = worker
        else:
            with self._lock:
                # stop() may have advanced the epoch while this producer was
                # joining a finished worker. Recheck in the same critical
                # section that reserves or publishes the next worker.
                if self._stopping or admission_epoch != self._admission_epoch:
                    raise RuntimeError("TTS audio output unavailable")
                if self._worker is finishing_worker:
                    self._worker = None
                current = self._worker
                if current is not None and current.thread.is_alive():
                    if current.stop_event.is_set():
                        raise RuntimeError("TTS audio output unavailable")
                    current.pending_writes += 1
                    enqueue_worker = current
                else:
                    self._generation += 1
                    self._pause_event.clear()
                    work_queue: queue.Queue[tuple[bytes, int]] = queue.Queue(
                        maxsize=_MAX_QUEUED_PCM_CHUNKS
                    )
                    stop_event = threading.Event()
                    generation = self._generation
                    thread = threading.Thread(
                        target=self._play_queue,
                        args=(generation, playback_id, work_queue, stop_event),
                        name="aurora-tts-pcm-playback",
                        daemon=True,
                    )
                    enqueue_worker = _PCMWorker(
                        generation=generation,
                        playback_id=playback_id,
                        work_queue=work_queue,
                        stop_event=stop_event,
                        thread=thread,
                        pending_writes=1,
                    )
                    self._worker = enqueue_worker
                    try:
                        thread.start()
                    except Exception:
                        if self._worker is enqueue_worker:
                            self._worker = None
                        raise RuntimeError("TTS audio output unavailable") from None

        try:
            for offset in range(0, len(pcm), chunk_size):
                self._require_enqueue_allowed(enqueue_worker, admission_epoch)
                chunk = pcm[offset : offset + chunk_size]
                try:
                    enqueue_worker.work_queue.put(
                        (chunk, sample_rate), timeout=_PCM_ENQUEUE_TIMEOUT_SECONDS
                    )
                except queue.Full:
                    error = RuntimeError("TTS audio output unavailable")
                    self._mark_worker_failed(enqueue_worker, error)
                    raise error from None
            self._require_enqueue_allowed(enqueue_worker, admission_epoch)
        finally:
            with self._lock:
                enqueue_worker.pending_writes -= 1

    def _enqueue_is_allowed(self, worker: _PCMWorker, admission_epoch: int) -> bool:
        with self._lock:
            return (
                not self._stopping
                and admission_epoch == self._admission_epoch
                and self._worker is worker
                and not worker.stop_event.is_set()
                and worker.failure is None
            )

    def _require_enqueue_allowed(self, worker: _PCMWorker, admission_epoch: int) -> None:
        if self._enqueue_is_allowed(worker, admission_epoch):
            return
        with self._lock:
            failure = worker.failure
        if failure is not None:
            self._mark_worker_failed(worker, failure)
        raise RuntimeError("TTS audio output unavailable")

    @staticmethod
    def _discard_queued_audio(worker: _PCMWorker) -> None:
        while True:
            try:
                worker.work_queue.get_nowait()
            except queue.Empty:
                return

    def _mark_worker_failed(self, worker: _PCMWorker, error: Exception) -> None:
        with self._lock:
            if worker.failure is None:
                worker.failure = error
                self._admission_epoch += 1
            worker.stop_event.set()
            self._discard_queued_audio(worker)

    def stop(self) -> None:
        """Stop current PCM playback."""
        with self._stop_lock:
            with self._lock:
                self._admission_epoch += 1
                self._stopping = True
                worker = self._worker
                self._pause_event.clear()
                if worker is not None:
                    worker.stop_event.set()
                    self._discard_queued_audio(worker)
            if worker is not None and worker.thread.is_alive():
                if worker.thread is threading.current_thread():
                    raise RuntimeError("TTS audio output unavailable")
                worker.thread.join(timeout=0.5)
                if worker.thread.is_alive():
                    raise RuntimeError("TTS audio output unavailable")

            with self._enqueue_lock, self._lock:
                if worker is not None:
                    self._discard_queued_audio(worker)
                    if self._worker is worker:
                        self._worker = None
                self._stopping = False

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
        result = "stopped"
        output_stream = None
        output_sample_rate: int | None = None
        try:
            self._invoke_callback(self._on_audio_stream_start, playback_id)
            while not stop_event.is_set() and self._is_active_generation(generation):
                try:
                    item = work_queue.get(timeout=0.05)
                except queue.Empty:
                    with self._lock:
                        if (
                            work_queue.empty()
                            and self._is_active_generation(generation)
                            and self._worker is not None
                            and self._worker.pending_writes == 0
                        ):
                            stop_event.set()
                            result = "completed"
                            break
                    continue
                pyaudio = self._ensure_pyaudio()
                if pyaudio is None:
                    raise RuntimeError("TTS audio output unavailable")
                if self._audio is None:
                    raise RuntimeError("TTS audio output unavailable")
                if output_stream is None or output_sample_rate != item[1]:
                    if output_stream is not None:
                        self._close_pcm_stream(output_stream)
                    output_stream = self._audio.open(
                        format=pyaudio.paInt16,
                        channels=1,
                        rate=item[1],
                        output=True,
                        frames_per_buffer=self._frames_per_buffer,
                    )
                    output_sample_rate = item[1]
                self._play_pcm_item(output_stream, item[0], generation, stop_event)
        except Exception as exc:
            log_debug(f"TTS PCM playback failure type={type(exc).__name__}")
            self._mark_worker_failed_for_generation(generation, exc)
        finally:
            with self._lock:
                worker = self._worker
                if worker is not None and worker.generation == generation:
                    failure = worker.failure
                    if failure is not None:
                        result = "failed"
                        self._discard_queued_audio(worker)
                    else:
                        failure = None
                else:
                    failure = None
            try:
                if output_stream is not None:
                    self._close_pcm_stream(output_stream)
                if result == "completed":
                    with self._lock:
                        if self._is_active_generation(generation):
                            stop_event.set()
                    self._invoke_callback(self._on_audio_stream_stop, playback_id)
                elif result == "failed" and failure is not None:
                    self._invoke_error_callback(playback_id, failure)
            finally:
                with self._lock:
                    worker = self._worker
                    if worker is not None and worker.generation == generation:
                        worker.completion_result = result
                        worker.completion.set()

    def _mark_worker_failed_for_generation(self, generation: int, error: Exception) -> None:
        with self._lock:
            worker = self._worker
            if worker is None or worker.generation != generation:
                return
            if worker.failure is None:
                worker.failure = error
                self._admission_epoch += 1
            worker.stop_event.set()
            self._discard_queued_audio(worker)

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
        stream: Any,
        audio: bytes,
        generation: int,
        stop_event: threading.Event,
    ) -> None:
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

    @staticmethod
    def _close_pcm_stream(stream: Any) -> None:
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
