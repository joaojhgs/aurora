"""Official PocketTTS provider adapter."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import importlib
import importlib.metadata
import importlib.resources
import math
import os
import queue
import shutil
import tempfile
import threading
from collections.abc import AsyncIterator, Callable, Iterable, Mapping
from concurrent.futures import Executor, Future
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, cast
from urllib.parse import urlsplit, urlunsplit

from app.helpers.aurora_logger import log_debug, log_warning
from app.services.tts.providers.base import (
    MAX_TTS_SAMPLE_RATE,
    MIN_TTS_SAMPLE_RATE,
    TTSProviderCapabilities,
    TTSProviderError,
    TTSProviderHealth,
    TTSStreamChunk,
    TTSSynthesisRequest,
    TTSSynthesisResult,
    TTSVoiceInfo,
    VoiceSelectionMode,
    validate_synthesis_request,
)
from app.services.tts.providers.piper import pcm_to_wav_bytes
from app.services.tts.voice_registry import (
    VoiceBaseIdentity,
    VoiceStateArtifactHandle,
    validate_logical_voice_id,
)

PocketTTSQualityTier = Literal["compact", "quality"]


class _DaemonSingleWorkerExecutor(Executor):
    """Single-worker executor without ThreadPoolExecutor atexit joining."""

    def __init__(self, *, thread_name_prefix: str) -> None:
        self._thread_name_prefix = thread_name_prefix
        self._tasks: queue.Queue[tuple[Future[Any], Any, tuple[Any, ...]] | None] = queue.Queue()
        self._lock = threading.Lock()
        self._shutdown = False
        self._thread: threading.Thread | None = None

    def submit(self, fn: Any, /, *args: Any, **kwargs: Any) -> Future[Any]:
        if kwargs:

            def call() -> Any:
                return fn(*args, **kwargs)

            task_args: tuple[Any, ...] = ()
        else:
            call = fn
            task_args = args
        future: Future[Any] = Future()
        with self._lock:
            if self._shutdown:
                raise RuntimeError("PocketTTS executor is shut down")
            self._ensure_thread_locked()
            self._tasks.put((future, call, task_args))
        return future

    def shutdown(self, wait: bool = True, *, cancel_futures: bool = False) -> None:
        with self._lock:
            self._shutdown = True
            if cancel_futures:
                self._cancel_queued_locked()
            thread = self._thread
            self._tasks.put(None)
        if wait and thread is not None:
            thread.join()

    def shutdown_bounded(self, timeout_s: float, *, cancel_futures: bool = False) -> bool:
        with self._lock:
            self._shutdown = True
            if cancel_futures:
                self._cancel_queued_locked()
            thread = self._thread
            self._tasks.put(None)
        if thread is None:
            return True
        thread.join(timeout_s)
        return not thread.is_alive()

    def _ensure_thread_locked(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._thread = threading.Thread(
            target=self._worker,
            name=f"{self._thread_name_prefix}_0",
            daemon=True,
        )
        self._thread.start()

    def _cancel_queued_locked(self) -> None:
        retained: list[tuple[Future[Any], Any, tuple[Any, ...]] | None] = []
        while True:
            try:
                task = self._tasks.get_nowait()
            except queue.Empty:
                break
            if task is None:
                retained.append(task)
                continue
            future, _fn, _args = task
            future.cancel()
        for task in retained:
            self._tasks.put(task)

    def _worker(self) -> None:
        while True:
            task = self._tasks.get()
            if task is None:
                return
            future, fn, args = task
            if not future.set_running_or_notify_cancel():
                continue
            try:
                result = fn(*args)
            except BaseException as exc:
                future.set_exception(exc)
            else:
                future.set_result(result)


_PRODUCT_LANGUAGE_ALIASES: Mapping[str, str] = {
    "en": "english",
    "en-us": "english",
    "en-gb": "english",
    "english": "english",
    "de": "german",
    "de-de": "german",
    "german": "german",
    "pt": "portuguese",
    "pt-br": "portuguese",
    "pt-pt": "portuguese",
    "portuguese": "portuguese",
    "it": "italian",
    "it-it": "italian",
    "italian": "italian",
    "es": "spanish",
    "es-es": "spanish",
    "es-mx": "spanish",
    "spanish": "spanish",
    "fr": "french",
    "fr-fr": "french",
    "french": "french",
}


@dataclass(frozen=True)
class PocketTTSConfigInfo:
    """Pinned PocketTTS package config metadata."""

    config_id: str
    product_language: str
    quality_tier: PocketTTSQualityTier
    layer_count: int
    compatibility_only: bool = False


POCKETTTS_CONFIGS: Mapping[str, PocketTTSConfigInfo] = {
    "english": PocketTTSConfigInfo(
        config_id="english",
        product_language="english",
        quality_tier="compact",
        layer_count=6,
        compatibility_only=True,
    ),
    "english_2026-01": PocketTTSConfigInfo(
        config_id="english_2026-01",
        product_language="english",
        quality_tier="compact",
        layer_count=6,
        compatibility_only=True,
    ),
    "english_2026-04": PocketTTSConfigInfo(
        config_id="english_2026-04",
        product_language="english",
        quality_tier="compact",
        layer_count=6,
    ),
    "german": PocketTTSConfigInfo(
        config_id="german",
        product_language="german",
        quality_tier="compact",
        layer_count=6,
    ),
    "german_24l": PocketTTSConfigInfo(
        config_id="german_24l",
        product_language="german",
        quality_tier="quality",
        layer_count=24,
    ),
    "portuguese": PocketTTSConfigInfo(
        config_id="portuguese",
        product_language="portuguese",
        quality_tier="compact",
        layer_count=6,
    ),
    "portuguese_24l": PocketTTSConfigInfo(
        config_id="portuguese_24l",
        product_language="portuguese",
        quality_tier="quality",
        layer_count=24,
    ),
    "italian": PocketTTSConfigInfo(
        config_id="italian",
        product_language="italian",
        quality_tier="compact",
        layer_count=6,
    ),
    "italian_24l": PocketTTSConfigInfo(
        config_id="italian_24l",
        product_language="italian",
        quality_tier="quality",
        layer_count=24,
    ),
    "spanish": PocketTTSConfigInfo(
        config_id="spanish",
        product_language="spanish",
        quality_tier="compact",
        layer_count=6,
    ),
    "spanish_24l": PocketTTSConfigInfo(
        config_id="spanish_24l",
        product_language="spanish",
        quality_tier="quality",
        layer_count=24,
    ),
    "french_24l": PocketTTSConfigInfo(
        config_id="french_24l",
        product_language="french",
        quality_tier="quality",
        layer_count=24,
    ),
}

_CONFIG_BY_LANGUAGE_AND_TIER: Mapping[tuple[str, PocketTTSQualityTier], str] = {
    ("english", "compact"): "english_2026-04",
    ("english", "quality"): "english_2026-04",
    ("german", "compact"): "german",
    ("german", "quality"): "german_24l",
    ("portuguese", "compact"): "portuguese",
    ("portuguese", "quality"): "portuguese_24l",
    ("italian", "compact"): "italian",
    ("italian", "quality"): "italian_24l",
    ("spanish", "compact"): "spanish",
    ("spanish", "quality"): "spanish_24l",
    ("french", "quality"): "french_24l",
}

_ENGLISH_LEGACY_CONFIGS = frozenset({"english", "english_2026-01"})
_MAX_CONFIG_YAML_BYTES = 2 * 1024 * 1024
_MAX_VOICE_STATE_BYTES = 64 * 1024 * 1024


@dataclass(frozen=True)
class PocketTTSVoiceStateConfig:
    """Ready logical voice state loaded under one PocketTTS base model."""

    voice_id: str
    artifact_handle: VoiceStateArtifactHandle
    display_name: str | None = None


@dataclass(frozen=True)
class PocketTTSProviderConfig:
    """Provider-private PocketTTS runtime configuration."""

    effective_language: str
    quality_tier: PocketTTSQualityTier = "compact"
    voices: tuple[PocketTTSVoiceStateConfig, ...] = ()
    preload: bool = True
    quantize: bool = False
    device: str = "cpu"
    temperature: float | None = None
    lsd_decode_steps: int | None = None
    noise_clamp: float | None = None
    eos_threshold: float | None = None
    request_timeout_s: float = 30.0
    queue_timeout_s: float = 5.0
    init_timeout_s: float = 60.0
    max_tokens: int = 120
    frames_after_eos: int = 1
    model_revision: str = "pocket-tts-2.1.0"
    config_id: str | None = None
    expected_sample_rate: int = 24000
    package_version: str | None = None
    config_yaml_bytes: bytes | None = None
    config_asset_refs: tuple[str, ...] = ()


@dataclass(frozen=True)
class _LoadedPocketTTSState:
    config: PocketTTSProviderConfig
    config_info: PocketTTSConfigInfo
    model: Any
    sample_rate: int
    voice_states: Mapping[str, Any]
    base_identity: str


def normalize_pockettts_language(language: str) -> str:
    """Normalize Aurora product language values for PocketTTS."""
    normalized = _PRODUCT_LANGUAGE_ALIASES.get(language.strip().lower().replace("_", "-"))
    if normalized is None:
        raise TTSProviderError("unsupported_voice", "PocketTTS language is unavailable")
    return normalized


def resolve_pockettts_config(
    language: str,
    quality_tier: PocketTTSQualityTier,
    *,
    config_id: str | None = None,
) -> PocketTTSConfigInfo:
    """Resolve provider-neutral language/tier settings to a pinned config."""
    if quality_tier not in ("compact", "quality"):
        raise TTSProviderError("unsupported_voice", "PocketTTS quality tier is unavailable")

    product_language = normalize_pockettts_language(language)
    if config_id is not None:
        if config_id == "french":
            raise TTSProviderError("unsupported_voice", "PocketTTS language is unavailable")
        info = POCKETTTS_CONFIGS.get(config_id)
        if info is None or info.product_language != product_language:
            raise TTSProviderError("unsupported_voice", "PocketTTS config is unavailable")
        if info.quality_tier != quality_tier:
            raise TTSProviderError("unsupported_voice", "PocketTTS config tier is unavailable")
        if info.compatibility_only and config_id not in _ENGLISH_LEGACY_CONFIGS:
            raise TTSProviderError("unsupported_voice", "PocketTTS config is unavailable")
        return info

    resolved = _CONFIG_BY_LANGUAGE_AND_TIER.get((product_language, quality_tier))
    if resolved is None:
        raise TTSProviderError("unsupported_voice", "PocketTTS language tier is unavailable")
    return POCKETTTS_CONFIGS[resolved]


def _load_pockettts_model_class() -> Any:
    try:
        module = importlib.import_module("pocket_tts")
    except Exception as exc:
        raise TTSProviderError("unavailable", "PocketTTS is unavailable") from exc
    try:
        return module.TTSModel
    except AttributeError as exc:
        raise TTSProviderError("unavailable", "PocketTTS is unavailable") from exc


def _validate_timeout(name: str, value: float) -> None:
    if not math.isfinite(value) or value <= 0:
        raise TTSProviderError("resource_exhausted", f"PocketTTS {name} is unavailable")


def _validate_provider_config(config: PocketTTSProviderConfig) -> None:
    if config.device != "cpu":
        raise TTSProviderError("unavailable", "PocketTTS device is unavailable")
    if not config.voices:
        raise TTSProviderError("unsupported_voice", "PocketTTS voice is unavailable")
    voice_ids = [voice.voice_id for voice in config.voices]
    if len(set(voice_ids)) != len(voice_ids):
        raise TTSProviderError("unsupported_voice", "PocketTTS voice is unavailable")
    for voice in config.voices:
        try:
            validate_logical_voice_id(voice.voice_id)
        except ValueError as exc:
            raise TTSProviderError("unsupported_voice", "PocketTTS voice is unavailable") from exc
        if voice.artifact_handle.voice_id != voice.voice_id:
            raise TTSProviderError("unsupported_voice", "PocketTTS voice is unavailable")
    _validate_timeout("request timeout", config.request_timeout_s)
    _validate_timeout("queue timeout", config.queue_timeout_s)
    _validate_timeout("init timeout", config.init_timeout_s)
    if config.temperature is not None and not math.isfinite(config.temperature):
        raise TTSProviderError("unavailable", "PocketTTS temperature is unavailable")
    if config.noise_clamp is not None and not math.isfinite(config.noise_clamp):
        raise TTSProviderError("unavailable", "PocketTTS noise clamp is unavailable")
    if config.eos_threshold is not None and not math.isfinite(config.eos_threshold):
        raise TTSProviderError("unavailable", "PocketTTS EOS threshold is unavailable")
    if config.lsd_decode_steps is not None and config.lsd_decode_steps <= 0:
        raise TTSProviderError("unavailable", "PocketTTS decode steps are unavailable")
    if (
        isinstance(config.expected_sample_rate, bool)
        or not isinstance(config.expected_sample_rate, int)
        or config.expected_sample_rate < MIN_TTS_SAMPLE_RATE
        or config.expected_sample_rate > MAX_TTS_SAMPLE_RATE
    ):
        raise TTSProviderError("invalid_audio", "PocketTTS sample rate is unavailable")


@dataclass(frozen=True)
class PocketTTSBaseIdentitySpec:
    """Path-free identity shared by TTS service and PocketTTS provider."""

    voice_base_identity: VoiceBaseIdentity
    health_identity: str
    config_info: PocketTTSConfigInfo


def _pockettts_package_version(config: PocketTTSProviderConfig) -> str:
    if config.package_version:
        return config.package_version
    try:
        return importlib.metadata.version("pocket-tts")
    except importlib.metadata.PackageNotFoundError:
        return config.model_revision


def _normalize_config_asset_ref(value: object) -> str:
    if not isinstance(value, str):
        raise TTSProviderError("unavailable", "PocketTTS config is unavailable")
    raw = value.strip()
    if not raw or "\\" in raw:
        raise TTSProviderError("unavailable", "PocketTTS config is unavailable")
    parsed = urlsplit(raw)
    if parsed.scheme:
        if parsed.scheme != "hf" or not parsed.netloc or not parsed.path:
            raise TTSProviderError("unavailable", "PocketTTS config is unavailable")
        parts = [part for part in parsed.path.split("/") if part not in ("", ".")]
        if not parts or any(part == ".." for part in parts):
            raise TTSProviderError("unavailable", "PocketTTS config is unavailable")
        return urlunsplit(("hf", parsed.netloc, "/" + "/".join(parts), "", ""))
    if raw.startswith("/") or raw.startswith("~") or (len(raw) >= 3 and raw[1:3] == ":/"):
        raise TTSProviderError("unavailable", "PocketTTS config is unavailable")
    parts = [part for part in raw.split("/") if part not in ("", ".")]
    if not parts or any(part == ".." for part in parts):
        raise TTSProviderError("unavailable", "PocketTTS config is unavailable")
    return "/".join(parts)


def _normalized_config_asset_refs(raw_refs: Iterable[object]) -> tuple[str, ...]:
    cleaned: set[str] = set()
    for value in raw_refs:
        cleaned.add(_normalize_config_asset_ref(value))
    return tuple(sorted(cleaned))


def _load_packaged_config_yaml_bytes(config_id: str) -> bytes:
    try:
        root = importlib.resources.files("pocket_tts")
    except (ModuleNotFoundError, AttributeError) as exc:
        raise TTSProviderError("unavailable", "PocketTTS config is unavailable") from exc
    candidates = (
        root.joinpath("config", f"{config_id}.yaml"),
        root.joinpath("config", f"{config_id}.yml"),
        root.joinpath("configs", f"{config_id}.yaml"),
        root.joinpath("configs", f"{config_id}.yml"),
        root.joinpath(f"{config_id}.yaml"),
        root.joinpath(f"{config_id}.yml"),
    )
    for resource in candidates:
        try:
            data = resource.read_bytes()
        except (FileNotFoundError, IsADirectoryError, OSError):
            continue
        if data:
            return data
    raise TTSProviderError("unavailable", "PocketTTS config is unavailable")


def _write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise TTSProviderError("unsupported_voice", "PocketTTS voice is unavailable")
        view = view[written:]


def _extract_yaml_asset_refs(config_yaml_bytes: bytes) -> tuple[str, ...]:
    if not config_yaml_bytes or len(config_yaml_bytes) > _MAX_CONFIG_YAML_BYTES:
        raise TTSProviderError("unavailable", "PocketTTS config is unavailable")
    try:
        import yaml  # type: ignore[import-untyped]

        parsed = yaml.safe_load(config_yaml_bytes)
    except Exception as exc:
        raise TTSProviderError("unavailable", "PocketTTS config is unavailable") from exc
    if not isinstance(parsed, Mapping):
        raise TTSProviderError("unavailable", "PocketTTS config is unavailable")
    refs: list[str] = []

    def visit(value: Any, key: str | None = None) -> None:
        if isinstance(value, Mapping):
            for child_key, child_value in value.items():
                visit(child_value, str(child_key))
            return
        if isinstance(value, list | tuple):
            for child in value:
                visit(child, key)
            return
        if isinstance(value, str) and key is not None:
            lowered = key.lower()
            if any(token in lowered for token in ("path", "file", "repo", "revision", "model")):
                refs.append(value)

    visit(parsed)
    normalized = _normalized_config_asset_refs(refs)
    if not normalized:
        raise TTSProviderError("unavailable", "PocketTTS config is unavailable")
    return normalized


def build_pockettts_base_identity_spec(
    *,
    config_info: PocketTTSConfigInfo,
    model_revision: str,
    package_version: str,
    config_yaml_bytes: bytes,
    config_asset_refs: Iterable[str] = (),
) -> PocketTTSBaseIdentitySpec:
    """Build the strict path-free resident model and registry identity."""
    parsed_refs = _extract_yaml_asset_refs(config_yaml_bytes)
    normalized_refs = _normalized_config_asset_refs(config_asset_refs) or parsed_refs
    if not normalized_refs:
        raise TTSProviderError("unavailable", "PocketTTS config is unavailable")
    yaml_digest = hashlib.sha256(config_yaml_bytes).hexdigest()
    digest = hashlib.sha256()
    digest.update(b"pockettts-provider-v2")
    digest.update(b"\0package:")
    digest.update(package_version.encode("utf-8"))
    digest.update(b"\0config:")
    digest.update(config_info.config_id.encode("utf-8"))
    digest.update(b"\0language:")
    digest.update(config_info.product_language.encode("utf-8"))
    digest.update(b"\0tier:")
    digest.update(config_info.quality_tier.encode("ascii"))
    digest.update(b"\0layers:")
    digest.update(str(config_info.layer_count).encode("ascii"))
    digest.update(b"\0revision:")
    digest.update(model_revision.encode("utf-8"))
    digest.update(b"\0config-yaml-sha256:")
    digest.update(yaml_digest.encode("ascii"))
    for ref in normalized_refs:
        digest.update(b"\0asset-ref:")
        digest.update(ref.encode("utf-8"))
    compatibility_group = (
        f"pockettts:{config_info.product_language}:{config_info.config_id}:"
        f"layers-{config_info.layer_count}:sha256:{digest.hexdigest()[:24]}"
    )
    return PocketTTSBaseIdentitySpec(
        voice_base_identity=VoiceBaseIdentity(
            runtime_target="pockettts-python",
            language_bundle=config_info.config_id,
            compatibility_group=compatibility_group,
        ),
        health_identity=compatibility_group,
        config_info=config_info,
    )


def resolve_pockettts_base_identity_spec(
    config: PocketTTSProviderConfig,
) -> PocketTTSBaseIdentitySpec:
    """Resolve the shared PocketTTS base identity without loading model weights."""
    config_info = resolve_pockettts_config(
        config.effective_language,
        config.quality_tier,
        config_id=config.config_id,
    )
    config_yaml_bytes = (
        config.config_yaml_bytes
        if config.config_yaml_bytes is not None
        else _load_packaged_config_yaml_bytes(config_info.config_id)
    )
    parsed_refs = _extract_yaml_asset_refs(config_yaml_bytes)
    asset_refs = config.config_asset_refs or parsed_refs
    if not asset_refs:
        raise TTSProviderError("unavailable", "PocketTTS config is unavailable")
    return build_pockettts_base_identity_spec(
        config_info=config_info,
        model_revision=config.model_revision,
        package_version=_pockettts_package_version(config),
        config_yaml_bytes=config_yaml_bytes,
        config_asset_refs=asset_refs,
    )


def _close_fd_once(fd: int | None) -> None:
    if fd is None or fd < 0:
        return
    with contextlib.suppress(OSError):
        os.close(fd)


def _read_verified_handle_bytes(handle: VoiceStateArtifactHandle) -> bytes:
    if handle.format != "safetensors":
        raise TTSProviderError("unsupported_voice", "PocketTTS voice is unavailable")
    if (
        isinstance(handle.size_bytes, bool)
        or not isinstance(handle.size_bytes, int)
        or handle.size_bytes <= 0
        or handle.size_bytes > _MAX_VOICE_STATE_BYTES
    ):
        raise TTSProviderError("unsupported_voice", "PocketTTS voice is unavailable")
    digest = hashlib.sha256()
    remaining = handle.size_bytes
    chunks: list[bytes] = []
    os.lseek(handle.fd, 0, os.SEEK_SET)
    while remaining:
        chunk = os.read(handle.fd, min(1024 * 1024, remaining))
        if not chunk:
            raise TTSProviderError("unsupported_voice", "PocketTTS voice is unavailable")
        chunks.append(chunk)
        digest.update(chunk)
        remaining -= len(chunk)
    extra = os.read(handle.fd, 1)
    if extra:
        raise TTSProviderError("unsupported_voice", "PocketTTS voice is unavailable")
    os.lseek(handle.fd, 0, os.SEEK_SET)
    if digest.hexdigest() != handle.sha256:
        raise TTSProviderError("unsupported_voice", "PocketTTS voice is unavailable")
    return b"".join(chunks)


def _materialize_voice_state_bytes(
    model: Any, voice: PocketTTSVoiceStateConfig, artifact_bytes: bytes
) -> Any:
    tmp_dir = Path(tempfile.mkdtemp(prefix="aurora-pockettts-state-"))
    try:
        os.chmod(tmp_dir, 0o700)
        temp_path = tmp_dir / f"{voice.voice_id.replace(':', '_')}.safetensors"
        out_fd = os.open(temp_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            _write_all(out_fd, artifact_bytes)
            os.fsync(out_fd)
        finally:
            os.close(out_fd)
        state = model.get_state_for_audio_prompt(temp_path)
        _validate_voice_state_semantics(state)
        return state
    except TTSProviderError:
        raise
    except Exception as exc:
        log_debug(f"PocketTTS voice state import failure type={type(exc).__name__}")
        raise TTSProviderError("unsupported_voice", "PocketTTS voice is unavailable") from exc
    finally:
        try:
            shutil.rmtree(tmp_dir)
        except Exception as exc:
            raise TTSProviderError("unavailable", "PocketTTS voice cleanup failed") from exc


def _validate_voice_state_semantics(state: Any) -> None:
    """Reject obviously malformed imported PocketTTS state before readiness."""
    if not isinstance(state, Mapping) or not state:
        raise TTSProviderError("unsupported_voice", "PocketTTS voice is unavailable")
    seen = 0
    has_offset = False

    def tensor_like(value: Any) -> bool:
        shape = getattr(value, "shape", None)
        if shape is None:
            return False
        try:
            shape_values = tuple(int(dim) for dim in shape)
        except (TypeError, ValueError) as exc:
            raise TTSProviderError("unsupported_voice", "PocketTTS voice is unavailable") from exc
        if not shape_values or any(dim <= 0 or dim > 1_000_000 for dim in shape_values):
            raise TTSProviderError("unsupported_voice", "PocketTTS voice is unavailable")
        dtype = str(getattr(value, "dtype", ""))
        if dtype and len(dtype) > 64:
            raise TTSProviderError("unsupported_voice", "PocketTTS voice is unavailable")
        finite = getattr(value, "isfinite", None)
        finite_result: bool | None = None
        if callable(finite):
            with contextlib.suppress(Exception):
                finite_value = finite()
                all_method = getattr(finite_value, "all", None)
                if callable(all_method):
                    finite_value = all_method()
                item_method = getattr(finite_value, "item", None)
                if callable(item_method):
                    finite_value = item_method()
                if isinstance(finite_value, bool):
                    finite_result = finite_value
        if finite_result is False:
            raise TTSProviderError("unsupported_voice", "PocketTTS voice is unavailable")
        return True

    def visit(value: Any, depth: int, key_path: tuple[str, ...]) -> bool:
        nonlocal seen, has_offset
        if depth > 8 or seen > 4096:
            raise TTSProviderError("unsupported_voice", "PocketTTS voice is unavailable")
        lowered_path = ".".join(key_path).lower()
        if isinstance(value, Mapping):
            if not value:
                raise TTSProviderError("unsupported_voice", "PocketTTS voice is unavailable")
            found_tensor = False
            for key, child in value.items():
                if not isinstance(key, str) or not key or len(key) > 240:
                    raise TTSProviderError("unsupported_voice", "PocketTTS voice is unavailable")
                seen += 1
                if visit(child, depth + 1, (*key_path, key)):
                    found_tensor = True
            if ("offset" in lowered_path or "cache" in lowered_path) and not found_tensor:
                raise TTSProviderError("unsupported_voice", "PocketTTS voice is unavailable")
            return found_tensor
        if isinstance(value, bytes | bytearray | memoryview | str):
            raise TTSProviderError("unsupported_voice", "PocketTTS voice is unavailable")
        if tensor_like(value):
            if "offset" in lowered_path:
                has_offset = True
            return True
        if ("offset" in lowered_path or "cache" in lowered_path) or not (
            isinstance(value, int | float | bool) or value is None
        ):
            raise TTSProviderError("unsupported_voice", "PocketTTS voice is unavailable")
        return False

    visit(state, 0, ())
    if not has_offset:
        raise TTSProviderError("unsupported_voice", "PocketTTS voice is unavailable")


def _flatten_audio_values(audio: Any) -> list[float]:
    """Convert common tensor/array/list audio shapes to a flat float list."""
    value = audio
    for method_name in ("detach", "cpu"):
        method = getattr(value, method_name, None)
        if callable(method):
            value = method()
    numpy_method = getattr(value, "numpy", None)
    if callable(numpy_method):
        value = numpy_method()
    tolist_method = getattr(value, "tolist", None)
    if callable(tolist_method):
        value = tolist_method()

    flattened: list[float] = []

    def append(item: Any) -> None:
        if isinstance(item, (bytes, bytearray, memoryview)):
            raise TTSProviderError("invalid_audio", "PocketTTS produced unsupported audio")
        if isinstance(item, Iterable) and not isinstance(item, (str, bytes, bytearray)):
            for child in item:
                append(child)
            return
        try:
            sample = float(item)
        except (TypeError, ValueError) as exc:
            raise TTSProviderError("invalid_audio", "PocketTTS produced unsupported audio") from exc
        if not math.isfinite(sample):
            raise TTSProviderError("invalid_audio", "PocketTTS produced invalid audio")
        flattened.append(max(-1.0, min(1.0, sample)))

    append(value)
    return flattened


def _audio_to_pcm16(audio: Any) -> bytes:
    pcm = bytearray()
    for sample in _flatten_audio_values(audio):
        integer = int(round(sample * 32767.0))
        pcm.extend(integer.to_bytes(2, byteorder="little", signed=True))
    if not pcm:
        raise TTSProviderError("invalid_audio", "PocketTTS produced empty audio")
    return bytes(pcm)


def _duration_ms(audio: bytes, sample_rate: int, channels: int = 1) -> float:
    return (len(audio) / (sample_rate * channels * 2)) * 1000


def _generation_kwargs(config: PocketTTSProviderConfig) -> dict[str, Any]:
    return {
        "max_tokens": config.max_tokens,
        "frames_after_eos": config.frames_after_eos,
        "copy_state": True,
    }


def _load_model_kwargs(config: PocketTTSProviderConfig) -> dict[str, Any]:
    kwargs: dict[str, Any] = {}
    if config.temperature is not None:
        kwargs["temp"] = config.temperature
    if config.lsd_decode_steps is not None:
        kwargs["lsd_decode_steps"] = config.lsd_decode_steps
    if config.noise_clamp is not None:
        kwargs["noise_clamp"] = config.noise_clamp
    if config.eos_threshold is not None:
        kwargs["eos_threshold"] = config.eos_threshold
    return kwargs


def _device_value(value: Any) -> str | None:
    if value is None:
        return None
    device_type = getattr(value, "type", None)
    if isinstance(device_type, str):
        return device_type
    return str(value).split(":", maxsplit=1)[0].lower()


def _iter_model_device_values(model: Any) -> Iterable[str]:
    for attr in ("device", "_device"):
        device = _device_value(getattr(model, attr, None))
        if device:
            yield device
    config = getattr(model, "config", None)
    device = _device_value(getattr(config, "device", None))
    if device:
        yield device
    parameters = getattr(model, "parameters", None)
    if callable(parameters):
        with contextlib.suppress(Exception):
            for parameter in parameters():
                device = _device_value(getattr(parameter, "device", None))
                if device:
                    yield device
                    return


def _validate_loaded_model_device(model: Any) -> None:
    devices = tuple(_iter_model_device_values(model))
    if not devices or any(device != "cpu" for device in devices):
        raise TTSProviderError("unavailable", "PocketTTS device is unavailable")


def _validate_loaded_model_identity(model: Any, config_info: PocketTTSConfigInfo) -> None:
    """Reject a loaded model that does not look like the selected config."""
    expected = config_info.config_id.lower()
    product_language = config_info.product_language.lower()
    origin_observed: str | None = None
    config_observed: list[str] = []
    language_observed: list[str] = []
    origin = getattr(model, "origin", None)
    if origin is not None:
        origin_name = getattr(origin, "name", None)
        if isinstance(origin_name, str):
            origin_observed = Path(origin_name).stem.lower()
    model_config = getattr(model, "config", None)
    for attr in ("config_id", "name"):
        value = getattr(model_config, attr, None)
        if isinstance(value, str):
            config_observed.append(Path(value).stem.lower())
    language = getattr(model_config, "language", None)
    if isinstance(language, str):
        language_observed.append(language.lower())
    if origin_observed != expected:
        raise TTSProviderError("unavailable", "PocketTTS config is unavailable")
    if config_observed and expected not in config_observed:
        raise TTSProviderError("unavailable", "PocketTTS config is unavailable")
    if language_observed and not any(
        value in {expected, product_language} for value in language_observed
    ):
        raise TTSProviderError("unavailable", "PocketTTS config is unavailable")


class PocketTTSProvider:
    """Provider wrapper for official PocketTTS model inference."""

    provider_id = "pockettts"

    def __init__(
        self,
        config: PocketTTSProviderConfig,
        *,
        model_class: Any | None = None,
    ) -> None:
        self._config = config
        self._model_class = model_class
        self._executor: _DaemonSingleWorkerExecutor | None = None
        self._executor_shutdown_task: asyncio.Task[bool] | None = None
        self._entry_lock = asyncio.Lock()
        self._load_lock = asyncio.Lock()
        self._state_lock = asyncio.Lock()
        self._loaded: _LoadedPocketTTSState | None = None
        self._started = False
        self._stopping = False
        self._reloading = False
        self._queued_requests: set[str] = set()
        self._active_requests: set[str] = set()
        self._cancelled_requests: set[str] = set()
        self._stream_wakeups: dict[str, Any] = {}
        self._stream_futures: set[asyncio.Future[Any]] = set()
        self._last_error: str | None = None
        self._owned_voice_fds: set[int] = {
            voice.artifact_handle.fd for voice in config.voices if voice.artifact_handle.fd >= 0
        }

    @property
    def capabilities(self) -> TTSProviderCapabilities:
        """Return conservative PocketTTS capabilities."""
        return TTSProviderCapabilities(
            provider_id=self.provider_id,
            voice_selection_mode=VoiceSelectionMode.SHARED_MODEL_STATE,
            max_resident_base_models=1,
            supports_finite_synthesis=True,
            supports_streaming=True,
            supports_cancel=True,
            supports_inflight_cancel=False,
            supported_formats=("raw", "wav"),
        )

    @property
    def base_identity(self) -> str | None:
        """Return the resident model identity when loaded."""
        return self._loaded.base_identity if self._loaded is not None else None

    async def start(self) -> None:
        """Load PocketTTS resources when preload is enabled."""
        try:
            _validate_provider_config(self._config)
            self._ensure_executor()
            if not self._config.preload:
                async with self._state_lock:
                    self._started = True
                    self._stopping = False
                    self._last_error = None
                return
            loaded = await self._build_loaded_state(self._config)
            async with self._state_lock:
                self._loaded = loaded
                self._started = True
                self._stopping = False
                self._last_error = None
        except asyncio.CancelledError:
            async with self._state_lock:
                self._close_owned_voice_fds_locked()
            await self._shutdown_executor(wait=False, cancel_futures=True)
            raise
        except Exception:
            async with self._state_lock:
                self._close_owned_voice_fds_locked()
            await self._shutdown_executor(wait=True, cancel_futures=True)
            raise

    async def reload(self, config: PocketTTSProviderConfig) -> None:
        """Atomically reload PocketTTS resources, retaining old state on failure."""
        new_fds = self._voice_fds_from_config(config)
        async with self._state_lock:
            self._owned_voice_fds.update(new_fds)
        try:
            _validate_provider_config(config)
        except Exception:
            async with self._state_lock:
                self._close_voice_fds_locked(new_fds)
            raise
        async with self._state_lock:
            if self._stopping:
                self._close_voice_fds_locked(new_fds)
                raise TTSProviderError("unavailable", "TTS provider is unavailable")
            self._reloading = True
        try:
            async with self._load_lock:
                loaded = await self._build_loaded_state(config)
        except asyncio.CancelledError:
            async with self._state_lock:
                self._reloading = False
                self._close_voice_fds_locked(new_fds)
            raise
        except TTSProviderError as exc:
            async with self._state_lock:
                self._last_error = str(exc)
                self._reloading = False
                self._close_voice_fds_locked(new_fds)
            raise
        except Exception as exc:
            async with self._state_lock:
                self._last_error = "unavailable"
                self._reloading = False
                self._close_voice_fds_locked(new_fds)
            raise TTSProviderError("unavailable", "PocketTTS reload failed") from exc
        async with self._state_lock:
            self._config = config
            self._loaded = loaded
            self._started = True
            self._reloading = False
            self._last_error = None

    async def stop(self) -> None:
        """Stop accepting work and wait for active model entry to drain."""
        wakeups: list[Any]
        was_cancelled = False
        streams_drained = False
        executor_drained = False
        entry_drained = False
        async with self._state_lock:
            self._started = False
            self._stopping = True
            self._reloading = False
            self._cancelled_requests.update(self._queued_requests)
            self._cancelled_requests.update(self._active_requests)
            wakeups = list(self._stream_wakeups.values())
        for wakeup in wakeups:
            wakeup()
        try:
            streams_drained = await self._drain_stream_futures(self._stream_drain_timeout_s())
        except asyncio.CancelledError:
            was_cancelled = True
        if not self._entry_lock.locked():
            try:
                async with self._entry_lock:
                    pass
            except asyncio.CancelledError:
                was_cancelled = True
        try:
            executor_drained = await self._shutdown_executor(
                wait=True,
                cancel_futures=True,
            )
        except asyncio.CancelledError:
            was_cancelled = True
        await asyncio.sleep(0)
        entry_drained = not self._entry_lock.locked()
        stopped_cleanly = streams_drained and executor_drained and entry_drained
        await self._mark_stopped(stopped_cleanly=stopped_cleanly)
        if was_cancelled:
            raise asyncio.CancelledError
        if not stopped_cleanly:
            raise TTSProviderError("resource_exhausted", "TTS provider is busy")

    async def _mark_stopped(self, *, stopped_cleanly: bool) -> None:
        async with self._state_lock:
            self._loaded = None
            self._queued_requests.clear()
            self._active_requests.clear()
            self._cancelled_requests.clear()
            self._stream_wakeups.clear()
            self._close_owned_voice_fds_locked()
            self._stopping = not stopped_cleanly
            if not stopped_cleanly:
                self._last_error = "PocketTTS model work did not stop"

    async def health(self) -> TTSProviderHealth:
        """Return readiness for the loaded PocketTTS base model."""
        async with self._state_lock:
            ready = (
                self._started
                and self._loaded is not None
                and not self._stopping
                and not self._reloading
            )
            loaded = self._loaded
            error = None if ready else self._last_error or "unavailable"
            active_voice = next(iter(loaded.voice_states), None) if loaded is not None else None
        return TTSProviderHealth(
            provider_id=self.provider_id,
            ready=ready,
            active_voice=active_voice,
            base_identity=loaded.base_identity if ready and loaded is not None else None,
            error=error,
        )

    async def list_voices(self) -> tuple[TTSVoiceInfo, ...]:
        """Return ready logical voice states for the resident base model."""
        if self._config.preload is False:
            await self._ensure_loaded()
        async with self._state_lock:
            loaded = self._loaded
            ready = (
                self._started and loaded is not None and not self._stopping and not self._reloading
            )
            config = self._config
        if loaded is None:
            return ()
        names = {voice.voice_id: voice.display_name for voice in config.voices}
        return tuple(
            TTSVoiceInfo(
                voice_id=voice_id,
                display_name=names.get(voice_id) or voice_id,
                ready=ready,
                language=loaded.config.effective_language,
            )
            for voice_id in loaded.voice_states
        )

    async def cancel(self, request_id: str) -> None:
        """Mark queued or active work as cancelled."""
        wakeup = None
        async with self._state_lock:
            if request_id in self._queued_requests or request_id in self._active_requests:
                self._cancelled_requests.add(request_id)
                wakeup = self._stream_wakeups.get(request_id)
        if wakeup is not None:
            wakeup()

    async def tracked_request_count(self) -> int:
        """Return tracked request state count for lifecycle tests."""
        async with self._state_lock:
            return (
                len(self._queued_requests)
                + len(self._active_requests)
                + len(self._cancelled_requests)
            )

    async def synthesize(self, request: TTSSynthesisRequest) -> TTSSynthesisResult:
        """Synthesize finite audio through PocketTTS without blocking the loop."""
        validate_synthesis_request(
            request,
            supported_formats=self.capabilities.supported_formats,
            supported_sample_rate=self._config.expected_sample_rate,
        )
        loaded = await self._ready_loaded_state()
        validate_synthesis_request(
            request,
            supported_formats=self.capabilities.supported_formats,
            supported_sample_rate=loaded.sample_rate,
        )
        voice_id, voice_state = self._resolve_voice(loaded, request.voice)
        await self._register_request(request.request_id)
        try:
            await self._reject_if_cancelled(request.request_id)
            audio = await self._run_model_entry(
                request.request_id,
                lambda: loaded.model.generate_audio(
                    voice_state,
                    request.text,
                    **_generation_kwargs(loaded.config),
                ),
                timeout_s=loaded.config.request_timeout_s,
                queue_timeout_s=loaded.config.queue_timeout_s,
            )
            await self._reject_if_cancelled(request.request_id)
            pcm = _audio_to_pcm16(audio)
            output = (
                pcm_to_wav_bytes(pcm, sample_rate=loaded.sample_rate)
                if request.audio_format == "wav"
                else pcm
            )
            return TTSSynthesisResult(
                audio=output,
                audio_format=request.audio_format,
                sample_rate=loaded.sample_rate,
                channels=1,
                duration_ms=_duration_ms(pcm, loaded.sample_rate),
                voice=voice_id,
            )
        finally:
            await self._cleanup_request(request.request_id)

    async def stream(self, request: TTSSynthesisRequest) -> AsyncIterator[TTSStreamChunk]:
        """Stream ordered PocketTTS chunks normalized to PCM."""
        validate_synthesis_request(
            request,
            supported_formats=self.capabilities.supported_formats,
            supported_sample_rate=self._config.expected_sample_rate,
        )
        loaded = await self._ready_loaded_state()
        validate_synthesis_request(
            request,
            supported_formats=self.capabilities.supported_formats,
            supported_sample_rate=loaded.sample_rate,
        )
        _voice_id, voice_state = self._resolve_voice(loaded, request.voice)
        await self._register_request(request.request_id)
        try:
            await self._reject_if_cancelled(request.request_id)
            sequence = 0
            async for chunk in self._stream_model_entry(
                request.request_id,
                lambda: loaded.model.generate_audio_stream(
                    voice_state,
                    request.text,
                    **_generation_kwargs(loaded.config),
                ),
                timeout_s=loaded.config.request_timeout_s,
                queue_timeout_s=loaded.config.queue_timeout_s,
            ):
                await self._reject_if_cancelled(request.request_id)
                pcm = _audio_to_pcm16(chunk)
                yield TTSStreamChunk(
                    sequence=sequence,
                    audio=pcm,
                    sample_rate=loaded.sample_rate,
                    channels=1,
                    duration_ms=_duration_ms(pcm, loaded.sample_rate),
                )
                sequence += 1
            yield TTSStreamChunk(
                sequence=sequence,
                audio=b"",
                sample_rate=loaded.sample_rate,
                channels=1,
                is_final=True,
            )
        finally:
            await self._cleanup_request(request.request_id)

    async def _ready_loaded_state(self) -> _LoadedPocketTTSState:
        async with self._state_lock:
            if not self._started or self._stopping:
                raise TTSProviderError("unavailable", "TTS provider is unavailable")
            if self._reloading:
                raise TTSProviderError("capability_changed", "TTS provider is changing")
            loaded = self._loaded
        if loaded is None:
            return await self._ensure_loaded()
        return loaded

    async def _ensure_loaded(self) -> _LoadedPocketTTSState:
        async with self._load_lock:
            async with self._state_lock:
                if not self._started or self._stopping:
                    raise TTSProviderError("unavailable", "TTS provider is unavailable")
                if self._reloading:
                    raise TTSProviderError("capability_changed", "TTS provider is changing")
                loaded = self._loaded
                config = self._config
            if loaded is not None:
                return loaded
            loaded = await self._build_loaded_state(config)
            async with self._state_lock:
                if self._stopping or self._reloading:
                    raise TTSProviderError("capability_changed", "TTS provider is changing")
                self._loaded = loaded
                self._last_error = None
            return loaded

    async def _build_loaded_state(self, config: PocketTTSProviderConfig) -> _LoadedPocketTTSState:
        _validate_provider_config(config)
        config_info = resolve_pockettts_config(
            config.effective_language,
            config.quality_tier,
            config_id=config.config_id,
        )
        identity_spec = resolve_pockettts_base_identity_spec(config)

        def load() -> _LoadedPocketTTSState:
            model_class = self._model_class or _load_pockettts_model_class()
            model = model_class.load_model(
                language=config_info.config_id,
                quantize=config.quantize,
                **_load_model_kwargs(config),
            )
            _validate_loaded_model_device(model)
            _validate_loaded_model_identity(model, config_info)
            raw_sample_rate = getattr(model, "sample_rate", None)
            if isinstance(raw_sample_rate, bool) or not isinstance(raw_sample_rate, int):
                raise TTSProviderError("invalid_audio", "PocketTTS sample rate is unavailable")
            sample_rate = raw_sample_rate
            if sample_rate != config.expected_sample_rate:
                raise TTSProviderError("invalid_audio", "PocketTTS sample rate is unavailable")
            voice_states: dict[str, Any] = {}
            try:
                for voice in config.voices:
                    handle = voice.artifact_handle
                    if handle.runtime_target != identity_spec.voice_base_identity.runtime_target:
                        raise TTSProviderError(
                            "unsupported_voice", "PocketTTS voice is unavailable"
                        )
                    if handle.language_bundle != identity_spec.voice_base_identity.language_bundle:
                        raise TTSProviderError(
                            "unsupported_voice", "PocketTTS voice is unavailable"
                        )
                    if (
                        handle.compatibility_group
                        != identity_spec.voice_base_identity.compatibility_group
                    ):
                        raise TTSProviderError(
                            "unsupported_voice", "PocketTTS voice is unavailable"
                        )
                    artifact_bytes = _read_verified_handle_bytes(handle)
                    self._close_owned_voice_fd(handle.fd)
                    voice_states[voice.voice_id] = _materialize_voice_state_bytes(
                        model, voice, artifact_bytes
                    )
            finally:
                for voice in config.voices:
                    handle = voice.artifact_handle
                    self._close_owned_voice_fd(handle.fd)
            return _LoadedPocketTTSState(
                config=config,
                config_info=identity_spec.config_info,
                model=model,
                sample_rate=sample_rate,
                voice_states=voice_states,
                base_identity=identity_spec.health_identity,
            )

        return cast(
            _LoadedPocketTTSState,
            await self._run_model_entry(
                None,
                load,
                timeout_s=config.init_timeout_s,
                queue_timeout_s=config.queue_timeout_s,
            ),
        )

    def _resolve_voice(self, loaded: _LoadedPocketTTSState, voice: str | None) -> tuple[str, Any]:
        voice_id = voice or next(iter(loaded.voice_states), None)
        if voice_id is None or voice_id not in loaded.voice_states:
            raise TTSProviderError("unsupported_voice", "Requested voice is unavailable")
        return voice_id, loaded.voice_states[voice_id]

    async def _register_request(self, request_id: str | None) -> None:
        if request_id is None:
            return
        async with self._state_lock:
            self._queued_requests.add(request_id)

    async def _activate_request(self, request_id: str | None) -> None:
        if request_id is None:
            return
        async with self._state_lock:
            self._queued_requests.discard(request_id)
            self._active_requests.add(request_id)

    async def _cleanup_request(self, request_id: str | None) -> None:
        if request_id is None:
            return
        async with self._state_lock:
            self._queued_requests.discard(request_id)
            self._active_requests.discard(request_id)
            self._cancelled_requests.discard(request_id)

    async def _reject_if_cancelled(self, request_id: str | None) -> None:
        if request_id is None:
            return
        async with self._state_lock:
            if request_id in self._cancelled_requests:
                raise TTSProviderError("cancelled", "TTS request was cancelled")

    async def _run_model_entry(
        self,
        request_id: str | None,
        func: Any,
        *,
        timeout_s: float,
        queue_timeout_s: float,
    ) -> Any:
        await self._acquire_entry_lock(queue_timeout_s)
        release_on_exit = True
        future: asyncio.Future[Any] | None = None
        try:
            await self._activate_request(request_id)
            await self._reject_if_cancelled(request_id)
            loop = asyncio.get_running_loop()
            future = loop.run_in_executor(self._ensure_executor(), func)
            try:
                return await asyncio.wait_for(asyncio.shield(future), timeout=timeout_s)
            except TimeoutError as exc:
                release_on_exit = False
                self._release_entry_lock_when_done(future)
                log_warning("PocketTTS model entry timed out")
                raise TTSProviderError("resource_exhausted", "TTS provider is busy") from exc
            except asyncio.CancelledError:
                release_on_exit = False
                self._release_entry_lock_when_done(future)
                raise
            except TTSProviderError:
                raise
            except Exception as exc:
                log_debug(f"PocketTTS provider failure type={type(exc).__name__}")
                raise TTSProviderError("unavailable", "PocketTTS synthesis failed") from exc
        finally:
            if release_on_exit:
                self._release_entry_lock()

    async def _stream_model_entry(
        self,
        request_id: str | None,
        stream_factory: Any,
        *,
        timeout_s: float,
        queue_timeout_s: float,
    ) -> AsyncIterator[Any]:
        await self._acquire_entry_lock(queue_timeout_s)
        loop = asyncio.get_running_loop()
        bridge: asyncio.Queue[tuple[str, Any]] = asyncio.Queue(maxsize=2)
        stop_event = threading.Event()
        producer_future: asyncio.Future[Any] | None = None

        def put_item(item: tuple[str, Any]) -> None:
            while not stop_event.is_set():
                try:
                    put_future = asyncio.run_coroutine_threadsafe(bridge.put(item), loop)
                except RuntimeError:
                    return
                try:
                    put_future.result(timeout=0.05)
                    return
                except TimeoutError:
                    put_future.cancel()
                    continue

        def produce() -> None:
            try:
                for chunk in stream_factory():
                    if stop_event.is_set():
                        break
                    put_item(("chunk", chunk))
                put_item(("done", None))
            except Exception as exc:
                put_item(("error", exc))
            finally:
                with contextlib.suppress(RuntimeError):
                    loop.call_soon_threadsafe(self._release_entry_lock)

        def wake_consumer() -> None:
            stop_event.set()

            def put_cancelled() -> None:
                if bridge.full():
                    with contextlib.suppress(asyncio.QueueEmpty):
                        bridge.get_nowait()
                with contextlib.suppress(asyncio.QueueFull):
                    bridge.put_nowait(("cancelled", None))

            with contextlib.suppress(RuntimeError):
                loop.call_soon_threadsafe(put_cancelled)

        try:
            await self._activate_request(request_id)
            await self._reject_if_cancelled(request_id)
            if request_id is not None:
                async with self._state_lock:
                    self._stream_wakeups[request_id] = wake_consumer
            producer_future = asyncio.ensure_future(
                loop.run_in_executor(self._ensure_executor(), produce)
            )
            self._track_stream_future(producer_future)
            while True:
                try:
                    kind, payload = await asyncio.wait_for(bridge.get(), timeout=timeout_s)
                except TimeoutError as exc:
                    stop_event.set()
                    log_warning("PocketTTS stream timed out")
                    raise TTSProviderError("resource_exhausted", "TTS provider is busy") from exc
                except asyncio.CancelledError:
                    stop_event.set()
                    raise
                if kind == "chunk":
                    yield payload
                    continue
                if kind == "done":
                    break
                if kind == "cancelled":
                    await self._reject_if_cancelled(request_id)
                    raise TTSProviderError("cancelled", "TTS request was cancelled")
                log_debug(f"PocketTTS stream failure type={type(payload).__name__}")
                raise TTSProviderError("unavailable", "PocketTTS synthesis failed")
        finally:
            stop_event.set()
            if request_id is not None:
                async with self._state_lock:
                    self._stream_wakeups.pop(request_id, None)
            if producer_future is not None:
                try:
                    await asyncio.wait_for(
                        asyncio.shield(producer_future),
                        timeout=max(0.1, min(timeout_s, 5.0)),
                    )
                except TimeoutError:
                    log_warning("PocketTTS stream producer did not stop before drain timeout")
                except asyncio.CancelledError:
                    raise
                except Exception:
                    pass

    async def _acquire_entry_lock(self, queue_timeout_s: float) -> None:
        try:
            await asyncio.wait_for(self._entry_lock.acquire(), timeout=queue_timeout_s)
        except TimeoutError as exc:
            raise TTSProviderError("resource_exhausted", "TTS provider is busy") from exc

    def _release_entry_lock(self) -> None:
        if self._entry_lock.locked():
            self._entry_lock.release()

    def _release_entry_lock_when_done(self, future: asyncio.Future[Any]) -> None:
        loop = asyncio.get_running_loop()

        def release(_future: asyncio.Future[Any]) -> None:
            with contextlib.suppress(asyncio.CancelledError):
                _future.exception()
            loop.call_soon_threadsafe(self._release_entry_lock)

        future.add_done_callback(release)

    def _ensure_executor(self) -> _DaemonSingleWorkerExecutor:
        if self._executor is None:
            self._executor = _DaemonSingleWorkerExecutor(
                thread_name_prefix="aurora-pockettts",
            )
        return self._executor

    async def _shutdown_executor(self, *, wait: bool, cancel_futures: bool) -> bool:
        executor = self._executor
        if executor is None:
            return True
        shutdown_task = self._executor_shutdown_task
        if shutdown_task is not None and shutdown_task.done():
            with contextlib.suppress(asyncio.CancelledError, Exception):
                drained = shutdown_task.result()
                if drained:
                    self._executor = None
                    self._executor_shutdown_task = None
                    return True
            self._executor_shutdown_task = None
            shutdown_task = None
        if shutdown_task is None:
            shutdown_task = asyncio.create_task(
                asyncio.to_thread(
                    executor.shutdown_bounded,
                    self._stream_drain_timeout_s(),
                    cancel_futures=cancel_futures,
                )
            )
            self._executor_shutdown_task = shutdown_task
            shutdown_task.add_done_callback(self._clear_executor_when_drained(executor))
        if not wait:
            return False
        try:
            drained = await asyncio.shield(shutdown_task)
        except asyncio.CancelledError:
            if shutdown_task.done():
                drained = False
                with contextlib.suppress(Exception):
                    drained = shutdown_task.result()
                    if drained:
                        self._executor = None
                        self._executor_shutdown_task = None
                    return drained
            else:
                raise
        if drained:
            self._executor = None
            self._executor_shutdown_task = None
        return drained

    def _clear_executor_when_drained(
        self, executor: _DaemonSingleWorkerExecutor
    ) -> Callable[[asyncio.Task[bool]], None]:
        def clear(done: asyncio.Task[bool]) -> None:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                drained = done.result()
                if drained and self._executor is executor:
                    self._executor = None
                    self._executor_shutdown_task = None

        return clear

    def _track_stream_future(self, future: asyncio.Future[Any]) -> None:
        self._stream_futures.add(future)

        def discard(done: asyncio.Future[Any]) -> None:
            self._stream_futures.discard(done)

        future.add_done_callback(discard)

    def _stream_drain_timeout_s(self) -> float:
        loaded = self._loaded
        timeout = (
            loaded.config.request_timeout_s
            if loaded is not None
            else self._config.request_timeout_s
        )
        return max(0.1, min(timeout, 5.0))

    async def _drain_stream_futures(self, timeout_s: float) -> bool:
        futures = tuple(self._stream_futures)
        if not futures:
            return True
        done, pending = await asyncio.wait(futures, timeout=timeout_s)
        for future in done:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                future.exception()
        return not pending

    def _discard_owned_voice_fd(self, fd: int) -> None:
        self._owned_voice_fds.discard(fd)

    def _close_owned_voice_fd(self, fd: int) -> None:
        if fd in self._owned_voice_fds:
            self._owned_voice_fds.discard(fd)
            _close_fd_once(fd)

    def _close_owned_voice_fds_locked(self) -> None:
        fds = tuple(self._owned_voice_fds)
        self._owned_voice_fds.clear()
        for fd in fds:
            _close_fd_once(fd)

    def _close_voice_fds_locked(self, fds: Iterable[int]) -> None:
        for fd in tuple(fds):
            if fd in self._owned_voice_fds:
                self._owned_voice_fds.discard(fd)
                _close_fd_once(fd)

    @staticmethod
    def _voice_fds_from_config(config: PocketTTSProviderConfig) -> set[int]:
        return {
            voice.artifact_handle.fd for voice in config.voices if voice.artifact_handle.fd >= 0
        }
