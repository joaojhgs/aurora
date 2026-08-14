# filepath: app/stt_wakeword/service.py
"""Wake Word Detection Service for Aurora.

This service listens for audio chunks on the message bus and detects wake words
using either OpenWakeWord or Porcupine backends.

Features:
- Subscribes to audio stream channels
- Processes audio chunks for wake word detection
- Emits WakeWordDetected events when wake word is found
- Supports multiple wake word backends (OpenWakeWord, Porcupine)
- Independent from transcription service
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import http.client
import ipaddress
import json
import os
import socket
import threading
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast
from urllib.error import HTTPError
from urllib.parse import urlparse, urlunparse
from urllib.request import HTTPRedirectHandler

from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.messaging import (
    AudioChunk,
    AudioFormat,
    AudioTopics,
    Envelope,
    MessageBus,
)
from app.messaging.priority_helpers import get_interactive_priority
from app.services.stt_wakeword.backends import (
    OpenWakeWordBackend,
    PorcupineBackend,
    WakeWordBackend,
)
from app.shared.config.interface import ConfigAPI
from app.shared.config.keys import ConfigKeys
from app.shared.config.models import System, Wakeword
from app.shared.contracts.models.common import EmptyInput, EmptyOutput
from app.shared.contracts.models.stt import (
    AudioSessionEvent,
    AudioSessionMethods,
    AudioSessionSampleLimits,
    AudioSessionStartRequest,
    STTAudioChunk,
    WakewordControl,
    WakeWordDetectRequest,
    WakeWordDetectResponse,
    WakeWordMethods,
    WakeWordModule,
)
from app.shared.contracts.registry import method_contract
from app.shared.messaging.models.stt_wakeword_models import (
    WakeWordBackendType,
    WakeWordControl as WakeWordControlEvent,  # Rename to avoid conflict
    WakeWordDetected,
    WakeWordTimeout,
)
from app.shared.services.base_service import BaseService
from app.shared.speech_language_policy import (
    SpeechLanguagePolicy,
    resolve_speech_language_policy,
)

config_api = ConfigAPI()


WAKEWORD_MODEL_CATALOG_ENV = "AURORA_WAKEWORD_MODEL_CATALOG"
WAKEWORD_MODEL_CACHE_ENV = "AURORA_WAKEWORD_MODEL_CACHE_DIR"
WAKEWORD_MODEL_CACHE_QUOTA_ENV = "AURORA_WAKEWORD_MODEL_CACHE_QUOTA_BYTES"
WAKEWORD_MODEL_DOWNLOAD_TIMEOUT_ENV = "AURORA_WAKEWORD_MODEL_DOWNLOAD_TIMEOUT_SECONDS"
DEFAULT_WAKEWORD_CACHE_QUOTA_BYTES = 1024 * 1024 * 1024
DOWNLOAD_CHUNK_BYTES = 1024 * 1024
_WAKEWORD_CACHE_LOCKS: dict[str, threading.Lock] = {}
_WAKEWORD_CACHE_LOCKS_GUARD = threading.Lock()


class WakeWordModelUnavailableError(RuntimeError):
    """Selected wakeword model cannot currently be used for inference."""


@dataclass(frozen=True)
class WakeWordCatalogEntry:
    """One allowlisted wakeword model download entry."""

    key: str
    url: str
    sha256: str
    size_bytes: int
    name: str


class _NoRedirectHandler(HTTPRedirectHandler):
    """Deny redirects so DNS/SSRF checks apply to the exact catalog URL."""

    def redirect_request(
        self,
        req: Any,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> None:
        raise HTTPError(req.full_url, code, "redirects are not allowed", headers, fp)


class _PinnedIPHTTPSConnection(http.client.HTTPSConnection):
    """HTTPS connection pinned to a prevalidated IP while retaining hostname/SNI."""

    def __init__(
        self,
        host: str,
        *,
        port: int,
        pinned_ip: str,
        timeout: float,
    ) -> None:
        super().__init__(host=host, port=port, timeout=timeout)
        self._pinned_ip = pinned_ip

    def connect(self) -> None:
        source_address = getattr(self, "source_address", None)
        sock = socket.create_connection(
            (self._pinned_ip, self.port),
            self.timeout,
            source_address,
        )
        context = cast(Any, self)._context
        self.sock = context.wrap_socket(sock, server_hostname=self.host)


def _is_remote_model_path(value: str) -> bool:
    """Return true for direct network model selections, which are not allowed."""
    return urlparse(value).scheme in {"http", "https"}


def _app_data_subdir(*parts: str) -> Path:
    """Return a durable app-data path without creating shared config state."""
    from app.shared.path_utils import get_data_dir

    return Path(get_data_dir()).joinpath(*parts)


def _hash_matches(path: Path, expected_sha256: str, expected_size: int | None = None) -> bool:
    """Return true when the cached file matches catalog size and SHA-256."""
    if expected_size is not None and path.stat().st_size != expected_size:
        return False
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(DOWNLOAD_CHUNK_BYTES), b""):
            digest.update(chunk)
    return digest.hexdigest().lower() == expected_sha256.lower()


def _cache_lock(key: str) -> threading.Lock:
    with _WAKEWORD_CACHE_LOCKS_GUARD:
        lock = _WAKEWORD_CACHE_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            _WAKEWORD_CACHE_LOCKS[key] = lock
        return lock


def _validate_sha256(value: Any) -> str:
    sha = str(value or "").strip().lower()
    if len(sha) != 64 or any(ch not in "0123456789abcdef" for ch in sha):
        raise ValueError("wakeword catalog entry requires a valid sha256")
    return sha


def _validate_size(value: Any) -> int:
    try:
        size = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("wakeword catalog entry requires size_bytes") from exc
    if size <= 0:
        raise ValueError("wakeword catalog entry requires positive size_bytes")
    return size


def _validate_https_download_url(url: str) -> tuple[str, int, str]:
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError("wakeword catalog downloads must use HTTPS")
    if parsed.username or parsed.password:
        raise ValueError("wakeword catalog downloads must not include credentials")
    port = parsed.port or 443
    pinned_ip = _public_ip_for_host(parsed.hostname, port)
    return parsed.hostname, port, pinned_ip


def _public_ip_for_host(hostname: str, port: int) -> str:
    try:
        infos = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise ValueError("wakeword catalog download host could not be resolved") from exc
    addresses = {info[4][0] for info in infos}
    if not addresses:
        raise ValueError("wakeword catalog download host could not be resolved")
    for address in sorted(addresses):
        ip = ipaddress.ip_address(address)
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        ):
            raise ValueError("wakeword catalog download host is not allowed")
    return str(sorted(addresses)[0])


def _wakeword_name_from_path(path: str) -> str:
    return (
        Path(str(path).split("?", 1)[0].split("#", 1)[0])
        .name.replace(".onnx", "")
        .replace(".ppn", "")
    )


class WakeWordService(BaseService):
    """Wake Word Detection service.

    Responsibilities:
    - Listen to audio stream events
    - Process audio chunks for wake word detection
    - Emit WakeWordDetected events
    - Support multiple backends (OpenWakeWord, Porcupine)
    - Handle wake word timeout logic
    """

    def __init__(self) -> None:
        """Initialize wake word service."""
        super().__init__(
            module=WakeWordModule.NAME,
            summary="Wake word detection service",
            capabilities=["wake_word_detection", "openwakeword", "porcupine"],
        )
        self._running = False
        self._enabled = False
        self._backend: WakeWordBackend | None = None
        self._backend_type: WakeWordBackendType | None = None

        # Configuration
        self._wake_words: list[str] = []
        self._sensitivity = 0.5
        self._model_paths: list[str] = []
        self._language_policy = resolve_speech_language_policy("en", "auto")
        self._readiness_status = "unavailable"
        self._readiness_message = "not_loaded"
        self._model_cache_dir = ""

        # State tracking
        self._current_stream_id: str | None = None
        self._current_source: str | None = None
        self._audio_format: AudioFormat | None = None

        log_info("WakeWordService initialized")

    def _inference_ready(self) -> bool:
        """Return true when wakeword inference can be called."""
        return self._backend is not None and self._readiness_status == "ready"

    def _refresh_callable_capabilities(self) -> None:
        """Advertise model-dependent capabilities only while inference is ready."""
        if self._inference_ready():
            capabilities = ["wake_word_detection"]
            if self._backend_type is not None:
                capabilities.append(self._backend_type.value)
            self._capabilities = capabilities
        else:
            self._capabilities = []

    async def _republish_readiness(self) -> None:
        """Refresh gateway discovery after model readiness changes."""
        self._refresh_callable_capabilities()
        if getattr(self, "_runtime_state", None) == "active":
            await self._publish_service_announcement()

    async def on_start(self) -> None:
        """Start the wake word service."""
        log_info("Starting WakeWordService...")

        # Load configuration
        await self._load_config()

        # Initialize wake word backend. Missing optional assets must not stop
        # the service from staying alive for later model selection/reload.
        await self._initialize_backend()

        # Subscribe to audio stream
        await self.bus.subscribe_event(AudioTopics.STREAM_MICROPHONE, self._on_audio_chunk)

        self._running = True
        self._enabled = self._backend is not None
        self._refresh_callable_capabilities()

        log_info(
            "WakeWordService started "
            f"(backend: {self._backend_type.value if self._backend_type else 'none'}, "
            f"status: {self._readiness_status})"
        )

    async def on_stop(self) -> None:
        """Stop the wake word service."""
        log_info("Stopping WakeWordService...")

        self._running = False
        self._enabled = False
        self.bus.unsubscribe(AudioTopics.STREAM_MICROPHONE, self._on_audio_chunk)

        # Cleanup backend resources
        if self._backend:
            await self._backend.cleanup()
            self._backend = None

        log_info("WakeWordService stopped")

    async def reload(self, config_section: str | None = None) -> None:
        """Reload service configuration.

        Args:
            config_section: The configuration section that changed (None = full reload)
        """
        log_info(f"Reloading WakeWordService configuration: section={config_section}")
        # Reload wake word backend if config changed
        if config_section is None or config_section in ("system", "services", "services.stt"):
            log_info("Reloading wake word backend due to config change...")
            (
                backend_type,
                sensitivity,
                model_paths,
                wake_words,
                language_policy,
            ) = await self._read_config()
            new_backend = await self._build_backend(
                backend_type=backend_type,
                model_paths=model_paths,
                sensitivity=sensitivity,
                wake_words=wake_words,
            )
            old_backend = self._backend
            if new_backend is not None:
                self._backend_type = backend_type
                self._sensitivity = sensitivity
                self._model_paths = model_paths
                self._wake_words = wake_words
                self._language_policy = language_policy
                self._backend = new_backend
                self._enabled = True
                if old_backend and old_backend is not self._backend:
                    await old_backend.cleanup()
            else:
                self._backend_type = backend_type
                self._sensitivity = sensitivity
                self._model_paths = model_paths
                self._wake_words = wake_words
                self._language_policy = language_policy
                self._backend = None
                self._enabled = False
                if old_backend is not None:
                    await old_backend.cleanup()
            await self._republish_readiness()
        log_info("WakeWordService configuration reloaded")

    async def _load_config(self) -> None:
        """Load configuration from config manager."""
        (
            self._backend_type,
            self._sensitivity,
            self._model_paths,
            self._wake_words,
            self._language_policy,
        ) = await self._read_config()

    async def _read_config(
        self,
    ) -> tuple[WakeWordBackendType, float, list[str], list[str], SpeechLanguagePolicy]:
        """Read wakeword config without mutating the live backend."""

        from app.shared.path_utils import resolve_path

        _t = 20.0
        wakeword_cfg = await config_api.aget(
            ConfigKeys.services.stt.wakeword, Wakeword, config_timeout=_t
        )
        system_cfg = await config_api.aget(ConfigKeys.system, System, config_timeout=_t)
        if not isinstance(system_cfg, System):
            system_cfg = System()
        language_policy = resolve_speech_language_policy(
            system_cfg.primary_language,
            system_cfg.voice_language,
        )

        # Backend configuration
        backend_str = wakeword_cfg.backend or "oww"
        backend_type = WakeWordBackendType(backend_str)

        # Wake word configuration
        sensitivity = wakeword_cfg.threshold if wakeword_cfg.threshold is not None else 0.5
        model_path = wakeword_cfg.model_path or "voice_models/jarvis.onnx"

        # JSON null / empty string must not become raw_paths [""] (breaks wake word labels / OWW)
        if model_path is None or (isinstance(model_path, str) and not str(model_path).strip()):
            raw_paths = ["voice_models/jarvis.onnx"]
        elif isinstance(model_path, str):
            # Split by comma if multiple paths provided
            if "," in model_path:
                raw_paths = [p.strip() for p in model_path.split(",")]
            else:
                raw_paths = [model_path]
        else:
            raw_paths = model_path

        # Resolve local paths relative to project root and catalog keys into cache.
        model_paths = []
        resolved_wake_words: list[str] = []
        try:
            for path in raw_paths:
                if isinstance(path, str) and self._is_catalog_model_key(path):
                    entry = self._catalog_entry_for_key(path)
                    model_paths.append(await self._download_model_to_cache(entry))
                    resolved_wake_words.append(entry.name)
                elif isinstance(path, str) and _is_remote_model_path(path):
                    raise WakeWordModelUnavailableError("catalog_required")
                else:
                    model_paths.append(str(resolve_path(path)))
                    resolved_wake_words.append(_wakeword_name_from_path(str(path)))
        except (WakeWordModelUnavailableError, OSError, ValueError, json.JSONDecodeError) as exc:
            self._readiness_status = "unavailable"
            self._readiness_message = self._safe_unavailable_reason(exc)
            log_warning("Wake word model selection unavailable: %s", self._readiness_message)
            model_paths = []
            resolved_wake_words = []

        wake_words = resolved_wake_words

        log_info("Wake word configuration loaded:")
        log_info(f"  Backend: {backend_type.value}")
        log_info(f"  Wake word count: {len(wake_words)}")
        log_info(f"  Model count: {len(model_paths)}")
        log_info(f"  Sensitivity: {sensitivity}")
        return backend_type, sensitivity, model_paths, wake_words, language_policy

    async def _initialize_backend(self) -> None:
        """Initialize the wake word detection backend."""
        self._backend = await self._build_backend(
            backend_type=self._backend_type,
            model_paths=self._model_paths,
            sensitivity=self._sensitivity,
            wake_words=self._wake_words,
        )
        log_info("Wake word backend initialized")

    async def _build_backend(
        self,
        *,
        backend_type: WakeWordBackendType | None,
        model_paths: list[str],
        sensitivity: float,
        wake_words: list[str],
    ) -> WakeWordBackend | None:
        """Create and initialize a backend before making it live."""

        log_info(f"Initializing wake word backend: {backend_type.value if backend_type else None}")
        if backend_type not in {WakeWordBackendType.OPENWAKEWORD, WakeWordBackendType.PORCUPINE}:
            raise ValueError(f"Unknown wake word backend: {backend_type}")

        if not model_paths:
            self._readiness_status = "unavailable"
            self._readiness_message = "models_missing"
            self._refresh_callable_capabilities()
            log_warning("Wake word backend unavailable; no selected model files are ready")
            return None

        missing_paths = [path for path in model_paths if not Path(path).is_file()]
        if missing_paths:
            self._readiness_status = "unavailable"
            self._readiness_message = "models_missing"
            self._refresh_callable_capabilities()
            log_warning("Wake word backend unavailable; selected model files are not cached yet")
            return None

        if backend_type == WakeWordBackendType.OPENWAKEWORD:
            backend = OpenWakeWordBackend(
                model_paths=model_paths,
                sensitivity=sensitivity,
                wake_words=wake_words,
            )
        elif backend_type == WakeWordBackendType.PORCUPINE:
            backend = PorcupineBackend(
                model_paths=model_paths,
                sensitivity=sensitivity,
                wake_words=wake_words,
            )
        else:
            raise ValueError(f"Unknown wake word backend: {backend_type}")

        try:
            self._readiness_status = "downloading"
            self._readiness_message = "preparing_backend"
            await backend.initialize()
            self._readiness_status = "ready"
            self._readiness_message = backend_type.value if backend_type else "ready"
            self._refresh_callable_capabilities()
            return backend
        except Exception as e:
            self._readiness_status = "unavailable"
            self._readiness_message = type(e).__name__
            self._refresh_callable_capabilities()
            log_warning(
                "Wake word backend unavailable; service remains active: %s",
                type(e).__name__,
            )
            return None

    def _wakeword_cache_dir(self) -> str:
        """Return writable cache directory for user-selected wakeword models."""
        if self._model_cache_dir:
            return self._model_cache_dir
        from app.shared.path_utils import ensure_path_writable_or_tmp

        preferred = os.environ.get(WAKEWORD_MODEL_CACHE_ENV) or str(
            _app_data_subdir("models", "wakeword")
        )
        self._model_cache_dir = ensure_path_writable_or_tmp(preferred, tmp_leaf="wakeword-models")
        return self._model_cache_dir

    def _is_catalog_model_key(self, value: str) -> bool:
        """Return true when a model selection is a catalog key, not a path."""
        if not value or _is_remote_model_path(value):
            return False
        parsed = urlparse(value)
        if parsed.scheme:
            return False
        path = Path(value)
        return (
            not path.is_absolute() and "/" not in value and "\\" not in value and "." not in value
        )

    def _catalog_entry_for_key(self, selected_key: str) -> WakeWordCatalogEntry:
        """Resolve a selected model key through an explicit local allowlist catalog."""
        catalog_path = os.environ.get(WAKEWORD_MODEL_CATALOG_ENV)
        if not catalog_path:
            raise WakeWordModelUnavailableError("catalog_missing")
        data = json.loads(Path(catalog_path).read_text(encoding="utf-8"))
        entries = data.get("models", data) if isinstance(data, dict) else data
        if not isinstance(entries, list):
            raise WakeWordModelUnavailableError("catalog_invalid")
        for raw_entry in entries:
            if not isinstance(raw_entry, dict):
                continue
            key = str(raw_entry.get("id") or raw_entry.get("key") or "").strip()
            if key != selected_key:
                continue
            sha256 = _validate_sha256(raw_entry.get("sha256"))
            size_bytes = _validate_size(raw_entry.get("size_bytes") or raw_entry.get("bytes"))
            url = str(raw_entry.get("url") or "").strip()
            _validate_https_download_url(url)
            name = str(raw_entry.get("name") or key).strip() or key
            return WakeWordCatalogEntry(
                key=key,
                url=url,
                sha256=sha256,
                size_bytes=size_bytes,
                name=name,
            )
        raise WakeWordModelUnavailableError("catalog_entry_missing")

    async def _download_model_to_cache(self, entry: WakeWordCatalogEntry) -> str:
        """Download a catalog-selected wakeword model into digest-addressed cache."""
        cache_dir = Path(self._wakeword_cache_dir())
        cache_dir.mkdir(parents=True, exist_ok=True)
        self._readiness_status = "downloading"
        self._readiness_message = "downloading_model"
        self._refresh_callable_capabilities()
        return await asyncio.to_thread(self._download_model_to_cache_sync, entry, cache_dir)

    def _download_model_to_cache_sync(self, entry: WakeWordCatalogEntry, cache_dir: Path) -> str:
        hostname, port, pinned_ip = _validate_https_download_url(entry.url)
        if entry.size_bytes > self._wakeword_cache_quota_bytes():
            raise WakeWordModelUnavailableError("catalog_entry_too_large")

        destination = self._cache_path_for_digest(cache_dir, entry.sha256)
        lock = _cache_lock(entry.sha256)
        with lock:
            if destination.is_file() and _hash_matches(destination, entry.sha256, entry.size_bytes):
                log_info("Wake word model cache hit")
                self._prune_wakeword_cache(cache_dir, keep_digests={entry.sha256})
                return str(destination)

            destination.parent.mkdir(parents=True, exist_ok=True)
            tmp_path = destination.parent / f".{entry.sha256}.{uuid.uuid4().hex}.part"
            try:
                self._stream_https_to_temp(entry, tmp_path, hostname, port, pinned_ip)
                os.replace(tmp_path, destination)
                if not _hash_matches(destination, entry.sha256, entry.size_bytes):
                    destination.unlink(missing_ok=True)
                    raise ValueError("wakeword catalog download checksum mismatch")
                self._prune_wakeword_cache(cache_dir, keep_digests={entry.sha256})
            finally:
                tmp_path.unlink(missing_ok=True)

        log_info("Wake word model cached")
        return str(destination)

    def _cache_path_for_digest(self, cache_dir: Path, sha256: str) -> Path:
        return cache_dir / sha256[:2] / sha256

    def _stream_https_to_temp(
        self,
        entry: WakeWordCatalogEntry,
        tmp_path: Path,
        hostname: str,
        port: int,
        pinned_ip: str,
    ) -> None:
        timeout = self._wakeword_download_timeout_seconds()
        parsed = urlparse(entry.url)
        target = urlunparse(("", "", parsed.path or "/", parsed.params, parsed.query, ""))
        connection = _PinnedIPHTTPSConnection(
            hostname,
            port=port,
            pinned_ip=pinned_ip,
            timeout=timeout,
        )
        total = 0
        digest = hashlib.sha256()
        try:
            connection.request(
                "GET",
                target,
                headers={"User-Agent": "AuroraWakeWordModelCache/1.0"},
            )
            response = connection.getresponse()
            if 300 <= response.status < 400:
                raise HTTPError(
                    entry.url,
                    response.status,
                    "redirects are not allowed",
                    response.headers,
                    response,
                )
            if response.status != 200:
                raise HTTPError(
                    entry.url,
                    response.status,
                    response.reason,
                    response.headers,
                    response,
                )
            content_length = response.headers.get("Content-Length")
            if content_length is not None and int(content_length) != entry.size_bytes:
                raise ValueError("wakeword catalog download size mismatch")
            with tmp_path.open("wb") as handle:
                while True:
                    chunk = response.read(DOWNLOAD_CHUNK_BYTES)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > entry.size_bytes:
                        raise ValueError("wakeword catalog download exceeded expected size")
                    digest.update(chunk)
                    handle.write(chunk)
        finally:
            connection.close()
        if total != entry.size_bytes:
            raise ValueError("wakeword catalog download size mismatch")
        if digest.hexdigest().lower() != entry.sha256:
            raise ValueError("wakeword catalog download checksum mismatch")

    def _safe_unavailable_reason(self, exc: BaseException) -> str:
        """Return a bounded status reason that cannot expose selected paths/IDs."""
        if isinstance(exc, WakeWordModelUnavailableError):
            return str(exc) or "model_unavailable"
        if isinstance(exc, json.JSONDecodeError):
            return "catalog_invalid"
        if isinstance(exc, ValueError):
            message = str(exc)
            if "HTTPS" in message:
                return "catalog_https_required"
            if "sha256" in message:
                return "catalog_digest_required"
            if "size_bytes" in message:
                return "catalog_size_required"
            if "not allowed" in message:
                return "catalog_host_denied"
            if "checksum" in message:
                return "catalog_checksum_mismatch"
            if "size mismatch" in message or "expected size" in message:
                return "catalog_size_mismatch"
            return "catalog_invalid"
        if isinstance(exc, OSError):
            return "model_path_unavailable"
        return type(exc).__name__

    def _wakeword_download_timeout_seconds(self) -> float:
        raw_timeout = os.environ.get(WAKEWORD_MODEL_DOWNLOAD_TIMEOUT_ENV, "30")
        try:
            timeout = float(raw_timeout)
        except ValueError:
            timeout = 30.0
        return min(max(timeout, 1.0), 120.0)

    def _wakeword_cache_quota_bytes(self) -> int:
        raw_quota = os.environ.get(WAKEWORD_MODEL_CACHE_QUOTA_ENV)
        if raw_quota is None:
            return DEFAULT_WAKEWORD_CACHE_QUOTA_BYTES
        try:
            quota = int(raw_quota)
        except ValueError:
            return DEFAULT_WAKEWORD_CACHE_QUOTA_BYTES
        return max(quota, 1)

    def _prune_wakeword_cache(self, cache_dir: Path, *, keep_digests: set[str]) -> None:
        quota = self._wakeword_cache_quota_bytes()
        files = [
            path
            for path in cache_dir.rglob("*")
            if path.is_file() and not path.name.startswith(".")
        ]
        total = sum(path.stat().st_size for path in files)
        if total <= quota:
            return
        candidates = sorted(
            (path for path in files if path.name not in keep_digests),
            key=lambda path: path.stat().st_mtime,
        )
        for path in candidates:
            if total <= quota:
                break
            try:
                size = path.stat().st_size
                path.unlink()
                total -= size
            except FileNotFoundError:
                continue

    async def _process_audio_data(
        self,
        data: bytes,
        stream_id: str = "default",
        source: str = "unknown",
        timestamp: float | None = None,
    ) -> None:
        """Process raw audio data for wake word detection.

        Args:
            data: Raw audio bytes
            stream_id: ID of the audio stream
            source: Source of the audio (e.g. "microphone")
            timestamp: Timestamp of the audio chunk
        """
        if not self._enabled or not self._inference_ready() or not self._backend:
            return

        try:
            # Run detection
            result = await self._backend.detect(data)

            if result.detected:
                log_info(
                    f"Wake word detected! (index: {result.wake_word_index}, conf: {result.confidence:.2f})"
                )

                # Emit event
                event = WakeWordDetected(
                    wake_word=(
                        self._wake_words[result.wake_word_index]
                        if result.wake_word_index >= 0
                        and result.wake_word_index < len(self._wake_words)
                        else "unknown"
                    ),
                    confidence=result.confidence,
                    source=source,
                    stream_id=stream_id,
                    timestamp=timestamp or 0.0,
                    backend=self._backend_type,
                )

                await self.bus.publish(
                    WakeWordMethods.DETECTED,
                    event,
                    event=True,
                    mesh=False,
                    priority=get_interactive_priority(),
                    origin="internal",
                )

        except Exception:
            log_error("Wake word detection failed")

    async def _on_audio_chunk(self, env: Envelope) -> None:
        """Handle incoming audio chunks from internal bus.

        Args:
            env: Message envelope containing AudioChunk
        """
        chunk: AudioChunk = env.payload

        # Track current stream info
        self._current_stream_id = chunk.stream_id
        self._current_source = chunk.source
        if chunk.format:
            self._audio_format = chunk.format

        await self._process_audio_data(
            chunk.data, stream_id=chunk.stream_id, source=chunk.source, timestamp=chunk.timestamp
        )

    @method_contract(
        method_id=WakeWordMethods.PROCESS_AUDIO,
        summary="Process audio chunk for wake word detection",
        input_model=STTAudioChunk,
        output_model=EmptyOutput,
        exposure="both",
        method_type="use",
        required_perms=[WakeWordMethods.PROCESS_AUDIO],
        callable_feature_ids=["wake_word_detection"],
    )
    async def _on_external_audio(self, chunk: STTAudioChunk) -> EmptyOutput:
        """Handle audio chunks from external API/WebRTC calls.

        Args:
            chunk: STTAudioChunk containing audio data

        Returns:
            EmptyOutput on success
        """
        import time

        await self._validate_streaming_audio_session(chunk)
        if not self._inference_ready():
            raise RuntimeError(f"Wake word backend unavailable: {self._readiness_message}")
        await self._process_audio_data(
            chunk.data,
            stream_id="external",
            source="external",
            timestamp=time.time(),
        )
        await self._publish_audio_session_event(
            chunk,
            "wakeword_audio_accepted",
            status="active",
            payload={"bytes": len(chunk.data), "sample_rate": chunk.sample_rate},
        )

        return EmptyOutput()

    async def _validate_streaming_audio_session(self, chunk: STTAudioChunk) -> None:
        """Require selector and Gateway-issued consent for streaming audio."""
        if not chunk.mesh_selector or not chunk.mesh_selector.has_routing_target():
            await self._publish_audio_session_event(
                chunk,
                "stream_denied",
                status="denied",
                payload={"reason": "selector_required"},
            )
            raise PermissionError("WakeWord.ProcessAudio requires an explicit mesh selector")
        if not chunk.session_id or not chunk.consent_token:
            await self._publish_audio_session_event(
                chunk,
                "stream_denied",
                status="denied",
                payload={"reason": "consent_token_required"},
            )
            raise PermissionError("WakeWord.ProcessAudio requires an audio session consent token")

        self._validate_streaming_audio_sample(chunk)
        result = await self.bus.request(
            AudioSessionMethods.START,
            AudioSessionStartRequest(
                session_id=chunk.session_id,
                consent_token=chunk.consent_token,
            ),
            timeout=5.0,
        )
        if not result.ok:
            await self._publish_audio_session_event(
                chunk,
                "stream_denied",
                status="denied",
                payload={"reason": result.error or "audio_session_denied"},
            )
            raise PermissionError(result.error or "audio session consent denied")

    def _validate_streaming_audio_sample(self, chunk: STTAudioChunk) -> None:
        limits = AudioSessionSampleLimits()
        if chunk.sample_rate < limits.min_sample_rate or chunk.sample_rate > limits.max_sample_rate:
            raise ValueError("audio sample_rate is outside session limits")
        if chunk.channels < 1 or chunk.channels > limits.max_channels:
            raise ValueError("audio channels are outside session limits")
        if chunk.format.lower() not in limits.allowed_formats:
            raise ValueError("audio format is outside session limits")
        if len(chunk.data) > limits.max_chunk_bytes:
            raise ValueError("audio chunk exceeds session limits")

    async def _publish_audio_session_event(
        self,
        chunk: STTAudioChunk,
        event_type: str,
        *,
        status: str,
        payload: dict[str, object],
    ) -> None:
        if not chunk.session_id:
            return
        await self.bus.publish(
            AudioSessionMethods.EVENTS,
            AudioSessionEvent(
                session_id=chunk.session_id,
                event_type=event_type,
                status=status,
                source_peer_id=chunk.caller_peer_id,
                target_peer_id=chunk.target_peer_id
                or (chunk.mesh_selector.peer_id if chunk.mesh_selector else None),
                privacy_class=chunk.privacy_class,
                redacted=True,
                correlation_id=chunk.correlation_id,
                payload=payload,
            ),
            event=True,
            mesh=False,
            origin="internal",
        )

    async def _process_audio_chunk(self, chunk: AudioChunk) -> None:
        """Process an audio chunk for wake word detection.

        Args:
            chunk: AudioChunk containing audio data
        """
        if not self._enabled or not self._inference_ready() or not self._backend:
            return
        try:
            # Detect wake word using configured backend
            detection_result = await self._backend.detect(chunk.data)

            # If wake word detected, emit event
            if detection_result.detected:
                wake_word = self._wake_words[detection_result.wake_word_index]

                await self.bus.publish(
                    WakeWordMethods.DETECTED,
                    WakeWordDetected(
                        wake_word=wake_word,
                        confidence=detection_result.confidence,
                        source=chunk.source,
                        stream_id=chunk.stream_id,
                        backend=self._backend_type,
                    ),
                    event=True,
                    priority=get_interactive_priority(),  # High priority for wake word detection
                )

        except Exception:
            log_error("Wake word detection failed")

    @method_contract(
        method_id=WakeWordMethods.CONTROL,
        summary="Handle wake word control commands",
        input_model=WakewordControl,
        output_model=EmptyOutput,
        exposure="internal",
        method_type="manage",
    )
    async def _on_control(self, data: WakewordControl) -> EmptyOutput:
        """Handle wake word control commands.

        Args:
            data: Validated WakewordControl payload
        """
        try:
            action = data.action.lower()

            if action == "start":
                self._enabled = self._inference_ready()
                log_info("Wake word detection started")

            elif action == "stop":
                self._enabled = False
                log_info("Wake word detection stopped")

            elif action == "pause":
                self._enabled = False
                log_info("Wake word detection paused")

            elif action == "resume":
                self._enabled = self._inference_ready()
                log_info("Wake word detection resumed")

            else:
                log_warning(f"Unknown wake word control action: {action}")

        except Exception as e:
            log_error(f"Error handling control command: {e}", exc_info=True)

        return EmptyOutput()

    @method_contract(
        method_id=WakeWordMethods.DETECT,
        summary="Check audio for wake word and return result",
        input_model=WakeWordDetectRequest,
        output_model=WakeWordDetectResponse,
        exposure="both",
        method_type="use",
        required_perms=[WakeWordMethods.DETECT],
        callable_feature_ids=["wake_word_detection"],
    )
    async def detect_wake_word(self, request: WakeWordDetectRequest) -> WakeWordDetectResponse:
        """Check audio chunk for wake word and return detection result.

        This endpoint is for external API consumers who want to check
        audio for wake words without triggering the internal workflow.

        Args:
            request: WakeWordDetectRequest with base64-encoded audio data

        Returns:
            WakeWordDetectResponse with detection result
        """
        try:
            if not self._inference_ready():
                raise RuntimeError(f"Wake word backend unavailable: {self._readiness_message}")
            backend = self._backend
            if backend is None:
                raise RuntimeError("Wake word backend unavailable")

            # Decode base64 audio
            try:
                audio_bytes = base64.b64decode(request.audio_data)
            except Exception as e:
                raise ValueError(f"Invalid base64 audio data: {e}") from e

            log_debug(f"Wake word detection request: {len(audio_bytes)} bytes")

            # Run detection
            try:
                result = await backend.detect(audio_bytes)
            except Exception as exc:
                log_warning(
                    "Wake word detection request failed: %s",
                    self._safe_detection_error(exc),
                )
                raise RuntimeError("Wake word detection failed") from None

            if result.detected:
                wake_word = (
                    self._wake_words[result.wake_word_index]
                    if 0 <= result.wake_word_index < len(self._wake_words)
                    else "unknown"
                )
                log_info(
                    f"Wake word detected via API: '{wake_word}' "
                    f"(confidence: {result.confidence:.2f})"
                )
                return WakeWordDetectResponse(
                    detected=True,
                    wake_word=wake_word,
                    confidence=result.confidence,
                )
            else:
                return WakeWordDetectResponse(
                    detected=False,
                    wake_word=None,
                    confidence=None,
                )

        except (ValueError, RuntimeError):
            raise

    def _safe_detection_error(self, exc: BaseException) -> str:
        """Return a generic backend detection failure reason."""
        if isinstance(exc, (asyncio.TimeoutError, TimeoutError)):
            return "backend_timeout"
        return "backend_error"
