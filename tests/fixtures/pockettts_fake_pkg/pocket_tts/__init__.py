"""Deterministic PocketTTS fake for process-mode integration tests."""

from __future__ import annotations

import json
import os
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

SAMPLE_RATE = 24000
_ENTRY_COUNTER_LOCK = threading.Lock()


class _FiniteBool:
    def all(self) -> _FiniteBool:
        return self

    def item(self) -> bool:
        return True


class _TensorLike:
    shape = (1,)
    dtype = "float32"

    def isfinite(self) -> _FiniteBool:
        return _FiniteBool()


class _Audio:
    def __init__(self, values: list[float]) -> None:
        self._values = values

    def detach(self) -> _Audio:
        return self

    def cpu(self) -> _Audio:
        return self

    def numpy(self) -> _Audio:
        return self

    def tolist(self) -> list[float]:
        return self._values


class TTSModel:
    """Subset of the official PocketTTS API used by Aurora's provider."""

    def __init__(self, language: str, *, quantize: bool = False, **kwargs: Any) -> None:
        self.sample_rate = SAMPLE_RATE
        self.origin = SimpleNamespace(name=f"{language}.yaml")
        self.config = SimpleNamespace(config_id=language, name=language, language=language)
        self.device = "cpu"
        self.language = language
        self.quantize = quantize
        self.kwargs = kwargs

    @classmethod
    def load_model(cls, language: str, quantize: bool = False, **kwargs: Any) -> TTSModel:
        _record("load_model", language=language, quantize=quantize, kwargs=kwargs)
        fail_file = os.environ.get("POCKETTTS_FAKE_FAIL_LOAD_FILE")
        if fail_file and Path(fail_file).exists():
            _record("load_failed", language=language)
            raise RuntimeError("configured load failure")
        cache_dir = os.environ.get("POCKETTTS_FAKE_CACHE_DIR")
        if cache_dir:
            marker = Path(cache_dir) / f"{language}.marker"
            marker.parent.mkdir(parents=True, exist_ok=True)
            if marker.exists():
                _record("cache_reused", language=language, marker=marker.name)
            else:
                marker.write_text("cached\n", encoding="utf-8")
                _record("cache_created", language=language, marker=marker.name)
        return cls(language, quantize=quantize, **kwargs)

    def parameters(self) -> tuple[Any, ...]:
        return ()

    def get_state_for_audio_prompt(self, path: Path) -> dict[str, Any]:
        _record("state_loaded", artifact=Path(path).name)
        return {
            "semantic": {"offset": _TensorLike(), "cache": {"value": _TensorLike()}},
            "acoustic": {"prompt": _TensorLike()},
        }

    def generate_audio(self, state: Any, text: str, **kwargs: Any) -> _Audio:
        del state
        with _Entry("generate_audio", text=text, kwargs=kwargs):
            return _Audio(_samples(text, multiplier=1))

    def generate_audio_stream(self, state: Any, text: str, **kwargs: Any) -> Iterator[_Audio]:
        del state
        with _Entry("generate_audio_stream", text=text, kwargs=kwargs):
            yield _Audio(_samples(text, multiplier=1))


class _Entry:
    def __init__(self, event: str, **payload: Any) -> None:
        self._event = event
        self._payload = payload

    def __enter__(self) -> None:
        active_path = _active_path()
        with _ENTRY_COUNTER_LOCK:
            active = _read_int(active_path) + 1
            _write_int(active_path, active)
            max_path = _max_active_path()
            _write_int(max_path, max(_read_int(max_path), active))
        _record(f"{self._event}_begin", active=active, **self._payload)
        _wait_if_blocked()

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        active_path = _active_path()
        with _ENTRY_COUNTER_LOCK:
            active = max(0, _read_int(active_path) - 1)
            _write_int(active_path, active)
        _record(f"{self._event}_end", active=active, failed=exc_type is not None)


def _samples(text: str, *, multiplier: int) -> list[float]:
    seed = sum(text.encode("utf-8")) or 1
    count = 480 * multiplier
    return [(((seed + index * 17) % 200) - 100) / 100.0 for index in range(count)]


def _wait_if_blocked() -> None:
    block_file = os.environ.get("POCKETTTS_FAKE_BLOCK_FILE")
    release_file = os.environ.get("POCKETTTS_FAKE_RELEASE_FILE")
    if not block_file or not release_file or not Path(block_file).exists():
        return
    _record("blocked")
    deadline = time.monotonic() + float(os.environ.get("POCKETTTS_FAKE_BLOCK_TIMEOUT", "20"))
    while time.monotonic() < deadline:
        if Path(release_file).exists():
            _record("released")
            return
        time.sleep(0.02)
    raise TimeoutError("fake PocketTTS release timeout")


def _record(event: str, **payload: Any) -> None:
    telemetry = os.environ.get("POCKETTTS_FAKE_TELEMETRY")
    if not telemetry:
        return
    row = {"event": event, "pid": os.getpid(), "time": time.monotonic(), **payload}
    path = Path(telemetry)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, sort_keys=True) + "\n")


def _state_root() -> Path:
    root = os.environ.get("POCKETTTS_FAKE_STATE_DIR")
    if root:
        path = Path(root)
    else:
        path = Path(os.environ.get("POCKETTTS_FAKE_TELEMETRY", "/tmp/pockettts-fake.jsonl")).parent
    path.mkdir(parents=True, exist_ok=True)
    return path


def _active_path() -> Path:
    return _state_root() / "active.txt"


def _max_active_path() -> Path:
    return _state_root() / "max_active.txt"


def _read_int(path: Path) -> int:
    try:
        return int(path.read_text(encoding="utf-8").strip() or "0")
    except FileNotFoundError:
        return 0


def _write_int(path: Path, value: int) -> None:
    path.write_text(f"{value}\n", encoding="utf-8")
