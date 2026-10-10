"""PCM playback worker shutdown ownership tests."""

from __future__ import annotations

import threading
import time
from types import SimpleNamespace

import pytest

from app.services.tts.playback import PCMServerPlayback


def test_blocked_pcm_worker_is_retained_until_stop_finishes() -> None:
    write_started = threading.Event()
    allow_write_to_finish = threading.Event()
    drained = threading.Event()

    class FakeStream:
        def write(self, _audio: bytes) -> None:
            write_started.set()
            allow_write_to_finish.wait()

        def stop_stream(self) -> None:
            return None

        def close(self) -> None:
            return None

    class FakeAudio:
        def __init__(self) -> None:
            self.terminate_calls = 0

        def open(self, **_kwargs) -> FakeStream:
            return FakeStream()

        def terminate(self) -> None:
            self.terminate_calls += 1

    audio = FakeAudio()
    playback = PCMServerPlayback(
        on_audio_stream_start=lambda: None,
        on_audio_stream_stop=drained.set,
    )
    playback._pyaudio = SimpleNamespace(paInt16=8)
    playback._audio = audio

    worker = None
    try:
        playback.play_pcm_async(b"\x01\x00", sample_rate=24_000)
        worker = playback._worker
        assert worker is not None
        assert write_started.wait(timeout=1)

        with pytest.raises(RuntimeError, match="TTS audio output unavailable"):
            playback.stop()
        assert playback._worker is worker
        assert worker.thread.is_alive()

        with pytest.raises(RuntimeError, match="TTS audio output unavailable"):
            playback.play_pcm_async(b"\x02\x00", sample_rate=24_000)
        assert playback._worker is worker
        assert worker.work_queue.empty()

        with pytest.raises(RuntimeError, match="TTS audio output unavailable"):
            playback.close()
        assert playback._audio is audio
        assert audio.terminate_calls == 0
    finally:
        allow_write_to_finish.set()
        if worker is not None:
            worker.thread.join(timeout=1)

    assert worker is not None
    assert not worker.thread.is_alive()
    assert worker.completion.is_set()
    assert worker.completion_result == "stopped"
    assert not drained.is_set()
    playback.stop()
    assert playback._worker is None
    playback.close()
    assert audio.terminate_calls == 1


def test_pcm_buffer_backpressures_until_full_audio_drains() -> None:
    write_started = threading.Event()
    release_write = threading.Event()
    completed = threading.Event()
    errors: list[Exception] = []
    written = bytearray()

    class FakeStream:
        def __init__(self, audio_output) -> None:  # type: ignore[no-untyped-def]
            self._audio_output = audio_output

        def write(self, audio: bytes) -> None:
            if not write_started.is_set():
                write_started.set()
                release_write.wait(timeout=2)
            written.extend(audio)

        def stop_stream(self) -> None:
            return None

        def close(self) -> None:
            self._audio_output.close_calls += 1

    class FakeAudio:
        def __init__(self) -> None:
            self.open_calls = 0
            self.close_calls = 0

        def open(self, **_kwargs) -> FakeStream:
            self.open_calls += 1
            return FakeStream(self)

    playback = PCMServerPlayback(
        on_audio_stream_start=lambda: None,
        on_audio_stream_stop=completed.set,
        on_audio_stream_error=lambda _playback_id, error: errors.append(error),
        frames_per_buffer=1,
    )
    playback._pyaudio = SimpleNamespace(paInt16=8)
    fake_audio = FakeAudio()
    playback._audio = fake_audio
    audio = bytes(range(80))
    enqueue_errors: list[Exception] = []

    def enqueue() -> None:
        try:
            playback.play_pcm_async(audio, sample_rate=24_000, playback_id=7)
        except Exception as exc:
            enqueue_errors.append(exc)

    producer = threading.Thread(target=enqueue)
    try:
        producer.start()
        assert write_started.wait(timeout=1)
        worker = playback._worker
        assert worker is not None
        deadline = time.monotonic() + 1
        while not worker.work_queue.full() and time.monotonic() < deadline:
            threading.Event().wait(0.005)

        assert worker.work_queue.maxsize > 0
        assert worker.work_queue.full()
        assert producer.is_alive()
        assert not worker.completion.is_set()
        assert not completed.is_set()

        release_write.set()
        producer.join(timeout=2)
        assert not producer.is_alive()
        assert enqueue_errors == []
        assert worker.completion.wait(timeout=2)
        assert worker.completion_result == "completed"
        assert completed.is_set()
        assert errors == []
        assert bytes(written) == audio
        assert fake_audio.open_calls == 1
        assert fake_audio.close_calls == 1
    finally:
        release_write.set()
        producer.join(timeout=2)
        playback.stop()


def test_pcm_write_failure_reports_error_without_successful_drain() -> None:
    failed = threading.Event()
    completed = threading.Event()
    failures: list[Exception] = []

    class FakeStream:
        def write(self, _audio: bytes) -> None:
            raise OSError("device stopped")

        def stop_stream(self) -> None:
            return None

        def close(self) -> None:
            return None

    class FakeAudio:
        def open(self, **_kwargs) -> FakeStream:
            return FakeStream()

    playback = PCMServerPlayback(
        on_audio_stream_start=lambda: None,
        on_audio_stream_stop=completed.set,
        on_audio_stream_error=lambda _playback_id, error: (failures.append(error), failed.set()),
        frames_per_buffer=1,
    )
    playback._pyaudio = SimpleNamespace(paInt16=8)
    playback._audio = FakeAudio()
    try:
        playback.play_pcm_async(b"\x01\x00", sample_rate=24_000, playback_id=9)
        worker = playback._worker
        assert worker is not None
        assert worker.completion.wait(timeout=1)
        assert failed.is_set()
        assert failures and isinstance(failures[0], OSError)
        assert worker.completion_result == "failed"
        assert not completed.is_set()
    finally:
        playback.stop()


def test_pcm_enqueue_timeout_fences_and_discards_accepted_tail(monkeypatch) -> None:
    monkeypatch.setattr("app.services.tts.playback._PCM_ENQUEUE_TIMEOUT_SECONDS", 0.25)
    write_started = threading.Event()
    release_write = threading.Event()
    failed = threading.Event()
    completed = threading.Event()
    written = bytearray()
    failures: list[Exception] = []

    class FakeStream:
        def write(self, audio: bytes) -> None:
            write_started.set()
            release_write.wait(timeout=2)
            written.extend(audio)

        def stop_stream(self) -> None:
            return None

        def close(self) -> None:
            return None

    class FakeAudio:
        def open(self, **_kwargs) -> FakeStream:
            return FakeStream()

    playback = PCMServerPlayback(
        on_audio_stream_start=lambda: None,
        on_audio_stream_stop=completed.set,
        on_audio_stream_error=lambda _playback_id, error: (failures.append(error), failed.set()),
        frames_per_buffer=1,
    )
    playback._pyaudio = SimpleNamespace(paInt16=8)
    playback._audio = FakeAudio()
    enqueue_errors: list[Exception] = []
    waiting_producer_errors: list[Exception] = []

    class ObservableEnqueueLock:
        def __init__(self) -> None:
            self._lock = threading.Lock()
            self.waiting_producer = threading.Event()

        def acquire(self, blocking: bool = True) -> bool:
            if threading.current_thread().name == "failure-waiting-pcm-producer":
                self.waiting_producer.set()
            return self._lock.acquire(blocking)

        def release(self) -> None:
            self._lock.release()

        def __enter__(self) -> ObservableEnqueueLock:
            self.acquire()
            return self

        def __exit__(self, *_args) -> None:
            self.release()

    enqueue_lock = ObservableEnqueueLock()
    playback._enqueue_lock = enqueue_lock  # type: ignore[assignment]

    def enqueue() -> None:
        try:
            playback.play_pcm_async(bytes(range(40)), sample_rate=24_000, playback_id=11)
        except Exception as exc:
            enqueue_errors.append(exc)

    def enqueue_waiting() -> None:
        try:
            playback.play_pcm_async(b"\x02\x00", sample_rate=24_000, playback_id=12)
        except Exception as exc:
            waiting_producer_errors.append(exc)

    producer = threading.Thread(target=enqueue)
    waiting_producer = threading.Thread(target=enqueue_waiting, name="failure-waiting-pcm-producer")
    initial_admission_epoch = playback._admission_epoch
    try:
        producer.start()
        assert write_started.wait(timeout=1)
        waiting_producer.start()
        assert enqueue_lock.waiting_producer.wait(timeout=1)
        worker = playback._worker
        assert worker is not None
        deadline = time.monotonic() + 1
        while not worker.work_queue.full() and time.monotonic() < deadline:
            threading.Event().wait(0.005)
        assert worker.work_queue.full()
        producer.join(timeout=1)
        assert not producer.is_alive()
        assert enqueue_errors and isinstance(enqueue_errors[0], RuntimeError)
        assert worker.failure is not None
        assert playback._admission_epoch == initial_admission_epoch + 1
        assert worker.stop_event.is_set()
        assert worker.work_queue.empty()
        assert not worker.completion.is_set()
        assert not completed.is_set()
        waiting_producer.join(timeout=1)
        assert not waiting_producer.is_alive()
        assert waiting_producer_errors and isinstance(waiting_producer_errors[0], RuntimeError)
        assert playback._worker is worker
        assert playback._generation == worker.generation

        release_write.set()
        assert worker.completion.wait(timeout=1)
        assert worker.completion_result == "failed"
        assert failed.is_set()
        assert failures and isinstance(failures[0], RuntimeError)
        assert bytes(written) == b"\x00\x01"
        assert not completed.is_set()
    finally:
        release_write.set()
        producer.join(timeout=2)
        waiting_producer.join(timeout=2)
        playback.stop()


def test_pcm_stop_invalidates_producer_waiting_for_enqueue_lock() -> None:
    class ObservableEnqueueLock:
        def __init__(self) -> None:
            self._lock = threading.Lock()
            self.producer_waiting = threading.Event()

        def acquire(self, blocking: bool = True) -> bool:
            if threading.current_thread().name == "pre-stop-pcm-producer":
                self.producer_waiting.set()
            return self._lock.acquire(blocking)

        def release(self) -> None:
            self._lock.release()

        def __enter__(self) -> ObservableEnqueueLock:
            self.acquire()
            return self

        def __exit__(self, *_args) -> None:
            self.release()

    started = threading.Event()
    playback = PCMServerPlayback(
        on_audio_stream_start=started.set,
        on_audio_stream_stop=lambda: None,
    )
    enqueue_lock = ObservableEnqueueLock()
    playback._enqueue_lock = enqueue_lock  # type: ignore[assignment]
    enqueue_lock.acquire()
    enqueue_errors: list[Exception] = []
    stop_errors: list[Exception] = []

    def enqueue() -> None:
        try:
            playback.play_pcm_async(b"\x01\x00", sample_rate=24_000)
        except Exception as exc:
            enqueue_errors.append(exc)

    def stop() -> None:
        try:
            playback.stop()
        except Exception as exc:
            stop_errors.append(exc)

    producer = threading.Thread(target=enqueue, name="pre-stop-pcm-producer")
    stopper = threading.Thread(target=stop)
    try:
        producer.start()
        assert enqueue_lock.producer_waiting.wait(timeout=1)
        stopper.start()
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            with playback._lock:
                if playback._stopping:
                    break
            threading.Event().wait(0.005)
        with playback._lock:
            assert playback._stopping

        enqueue_lock.release()
        producer.join(timeout=1)
        stopper.join(timeout=1)
        assert not producer.is_alive()
        assert not stopper.is_alive()
        assert enqueue_errors and isinstance(enqueue_errors[0], RuntimeError)
        assert stop_errors == []
        assert playback._worker is None
        assert not started.is_set()
        with playback._lock:
            assert not playback._stopping
    finally:
        if enqueue_lock._lock.locked():
            enqueue_lock.release()
        producer.join(timeout=1)
        stopper.join(timeout=1)
