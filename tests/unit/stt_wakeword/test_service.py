"""Unit tests for STT Wake Word Service.

Tests cover:
- Service initialization and lifecycle
- Configuration loading
- Backend initialization (OpenWakeWord, Porcupine)
- Audio chunk processing
- Wake word detection
- Control commands (start/stop/pause/resume)
- Error handling
"""

import asyncio
import base64
import hashlib
import json
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, Mock, patch
from urllib.error import HTTPError

import pytest

from app.messaging import AudioChunk, AudioFormat, AudioTopics, Envelope, MessageBus
from app.services.stt_wakeword.messages import (
    WakeWordBackendType,
    WakeWordControl,
    WakeWordDetected,
)
from app.services.stt_wakeword.service import (
    WAKEWORD_MODEL_CACHE_QUOTA_ENV,
    WAKEWORD_MODEL_CATALOG_ENV,
    WakeWordCatalogEntry,
    WakeWordService,
    _NoRedirectHandler,
    _PinnedIPHTTPSConnection,
)
from app.shared.config.models import Wakeword
from app.shared.contracts.models.stt import WakeWordDetectRequest, WakeWordMethods

# Mock hardware dependencies before imports
sys.modules["openwakeword"] = MagicMock()
sys.modules["openwakeword.model"] = MagicMock()
sys.modules["pvporcupine"] = MagicMock()


@pytest.fixture
def mock_bus():
    """Create a mock message bus."""
    bus = Mock(spec=MessageBus)
    bus.subscribe = Mock()
    bus.subscribe_event = AsyncMock()
    bus.publish = AsyncMock()
    return bus


@pytest.fixture
def mock_config():
    """Mock config manager to avoid loading real config."""
    with patch("app.services.stt_wakeword.service.config_api") as mock_cfg:
        mock_cfg.get.side_effect = lambda key, default: {
            "services.stt.wake_word.backend": "oww",
            "services.stt.wake_word.threshold": 0.5,
            "services.stt.wake_word.model_path": "voice_models/jarvis.onnx",
        }.get(key, default)
        yield mock_cfg


@pytest.fixture
def mock_backend():
    """Create a mock wake word backend."""
    backend = Mock()
    backend.initialize = AsyncMock()
    backend.cleanup = AsyncMock()
    backend.detect = AsyncMock()
    return backend


def mark_wakeword_ready(service: WakeWordService) -> None:
    service._readiness_status = "ready"


@pytest.fixture
def service(mock_bus, mock_config):
    """Create WakeWordService instance with mocked dependencies."""
    with patch("app.shared.services.base_service.get_bus_singleton", return_value=mock_bus):
        yield WakeWordService()


# ============================================================================
# Initialization Tests
# ============================================================================


def test_service_initialization(service, mock_bus):
    """Test service initializes with correct defaults."""
    # Service uses singleton bus now
    assert service is not None
    assert service._running is False
    assert service._enabled is False
    assert service._backend is None
    assert service._backend_type is None


# ============================================================================
# Configuration Tests
# ============================================================================


@pytest.mark.asyncio
async def test_load_config_with_string_model_path(mock_bus):
    """Test loading configuration with string model path."""
    with patch("app.services.stt_wakeword.service.config_api") as mock_cfg:
        mock_cfg.aget = AsyncMock(
            return_value=Wakeword(
                backend="oww", threshold=0.7, model_path="voice_models/aurora.onnx"
            )
        )

        with (
            patch("app.shared.services.base_service.get_bus_singleton", return_value=mock_bus),
            patch("app.shared.path_utils.resolve_path", side_effect=lambda p: Path(p)),
        ):
            service = WakeWordService()
        await service._load_config()
        assert service._wake_words == ["aurora"]


@pytest.mark.asyncio
async def test_load_config_with_list_model_paths(mock_bus):
    """Test loading configuration with comma-separated model paths."""
    with patch("app.services.stt_wakeword.service.config_api") as mock_cfg:
        mock_cfg.aget = AsyncMock(
            return_value=Wakeword(
                backend="pvp",
                threshold=0.6,
                model_path="voice_models/aurora.ppn,voice_models/jarvis.ppn",
            )
        )

        with (
            patch("app.shared.services.base_service.get_bus_singleton", return_value=mock_bus),
            patch("app.shared.path_utils.resolve_path", side_effect=lambda p: Path(p)),
        ):
            service = WakeWordService()
        await service._load_config()
        assert service._wake_words == ["aurora", "jarvis"]


@pytest.mark.asyncio
async def test_load_config_with_none_model_path(mock_bus):
    """Test loading configuration with None model path uses default."""
    with patch("app.services.stt_wakeword.service.config_api") as mock_cfg:
        mock_cfg.aget = AsyncMock(
            return_value=Wakeword(backend="oww", threshold=0.5, model_path=None)
        )

        with (
            patch("app.shared.services.base_service.get_bus_singleton", return_value=mock_bus),
            patch("app.shared.path_utils.resolve_path", side_effect=lambda p: Path(p)),
        ):
            service = WakeWordService()
        await service._load_config()
        assert service._wake_words == ["jarvis"]


# ============================================================================
# Backend Initialization Tests
# ============================================================================


@pytest.mark.asyncio
async def test_initialize_openwakeword_backend(service, tmp_path):
    """Test initialization of OpenWakeWord backend."""
    service._backend_type = WakeWordBackendType.OPENWAKEWORD
    model_path = tmp_path / "jarvis.onnx"
    model_path.write_bytes(b"model")
    service._model_paths = [str(model_path)]
    service._sensitivity = 0.5
    service._wake_words = ["jarvis"]

    with patch("app.services.stt_wakeword.service.OpenWakeWordBackend") as mock_oww_class:
        mock_backend = Mock()
        mock_backend.initialize = AsyncMock()
        mock_oww_class.return_value = mock_backend

        await service._initialize_backend()

        mock_oww_class.assert_called_once_with(
            model_paths=[str(model_path)], sensitivity=0.5, wake_words=["jarvis"]
        )
        mock_backend.initialize.assert_called_once()
        assert service._backend == mock_backend
        assert service._readiness_status == "ready"


@pytest.mark.asyncio
async def test_initialize_porcupine_backend(service, tmp_path):
    """Test initialization of Porcupine backend."""
    service._backend_type = WakeWordBackendType.PORCUPINE
    model_path = tmp_path / "aurora.ppn"
    model_path.write_bytes(b"model")
    service._model_paths = [str(model_path)]
    service._sensitivity = 0.7
    service._wake_words = ["aurora"]

    with patch("app.services.stt_wakeword.service.PorcupineBackend") as mock_porcupine_class:
        mock_backend = Mock()
        mock_backend.initialize = AsyncMock()
        mock_porcupine_class.return_value = mock_backend

        await service._initialize_backend()

        mock_porcupine_class.assert_called_once_with(
            model_paths=[str(model_path)], sensitivity=0.7, wake_words=["aurora"]
        )
        mock_backend.initialize.assert_called_once()
        assert service._backend == mock_backend


@pytest.mark.asyncio
async def test_missing_wakeword_model_keeps_service_unavailable(service, tmp_path):
    """Absent selected model files do not crash service startup."""
    service._backend_type = WakeWordBackendType.OPENWAKEWORD
    missing_model = tmp_path / "missing.onnx"

    backend = await service._build_backend(
        backend_type=service._backend_type,
        model_paths=[str(missing_model)],
        sensitivity=0.5,
        wake_words=["missing"],
    )

    assert backend is None
    assert service._readiness_status == "unavailable"
    assert service._readiness_message == "models_missing"
    assert "wake_word_detection" not in service._capabilities


@pytest.mark.asyncio
async def test_wakeword_readiness_republishes_after_recovery(service, tmp_path):
    """A recovered backend updates callable capabilities and gateway discovery."""
    service._backend_type = WakeWordBackendType.OPENWAKEWORD
    service._runtime_state = "active"
    service._publish_service_announcement = AsyncMock()
    model_path = tmp_path / "ready.onnx"
    model_path.write_bytes(b"model")

    with patch("app.services.stt_wakeword.service.OpenWakeWordBackend") as mock_oww_class:
        mock_backend = Mock()
        mock_backend.initialize = AsyncMock()
        mock_oww_class.return_value = mock_backend

        service._backend = await service._build_backend(
            backend_type=service._backend_type,
            model_paths=[str(model_path)],
            sensitivity=0.5,
            wake_words=["ready"],
        )
        await service._republish_readiness()

    assert "wake_word_detection" in service._capabilities
    service._publish_service_announcement.assert_awaited_once()


@pytest.mark.asyncio
async def test_wakeword_catalog_model_downloads_and_reuses_digest_cache(
    service, tmp_path, monkeypatch
):
    """Catalog-selected wakeword models download on demand and reuse digest cache."""
    model_bytes = b"wakeword model bytes"
    expected_sha = hashlib.sha256(model_bytes).hexdigest()
    cache_dir = tmp_path / "cache"
    monkeypatch.setenv("AURORA_WAKEWORD_MODEL_CACHE_DIR", str(cache_dir))
    calls = []

    def fake_validate(url):
        calls.append(("validate", url))
        return ("models.example", 443, "93.184.216.34")

    def fake_stream(entry, destination, hostname, port, pinned_ip):
        assert (hostname, port, pinned_ip) == ("models.example", 443, "93.184.216.34")
        calls.append(("download", entry.url))
        Path(destination).write_bytes(model_bytes)

    monkeypatch.setattr(
        "app.services.stt_wakeword.service._validate_https_download_url", fake_validate
    )
    monkeypatch.setattr(service, "_stream_https_to_temp", fake_stream)
    entry = WakeWordCatalogEntry(
        key="aurora",
        url="https://models.example/aurora.onnx",
        sha256=expected_sha,
        size_bytes=len(model_bytes),
        name="aurora",
    )
    first_path = await service._download_model_to_cache(entry)
    second_path = await service._download_model_to_cache(entry)

    assert first_path == second_path
    assert Path(first_path).name == expected_sha
    assert Path(first_path).read_bytes() == model_bytes
    assert calls == [
        ("validate", "https://models.example/aurora.onnx"),
        ("download", "https://models.example/aurora.onnx"),
        ("validate", "https://models.example/aurora.onnx"),
    ]


@pytest.mark.asyncio
async def test_wakeword_catalog_download_rejects_bad_checksum(service, tmp_path, monkeypatch):
    """Hash metadata from a catalog entry is enforced before activation."""
    monkeypatch.setenv("AURORA_WAKEWORD_MODEL_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setattr(
        "app.services.stt_wakeword.service._validate_https_download_url",
        lambda _url: ("models.example", 443, "93.184.216.34"),
    )

    def fake_stream(entry, destination, hostname, port, pinned_ip):
        del hostname, port, pinned_ip
        del entry
        Path(destination).write_bytes(b"wrong bytes")

    monkeypatch.setattr(service, "_stream_https_to_temp", fake_stream)
    entry = WakeWordCatalogEntry(
        key="aurora",
        url="https://models.example/aurora.onnx",
        sha256="0" * 64,
        size_bytes=len(b"wrong bytes"),
        name="aurora",
    )

    with pytest.raises(ValueError, match="checksum"):
        await service._download_model_to_cache(entry)


@pytest.mark.asyncio
async def test_wakeword_direct_url_selection_is_denied_fail_soft(mock_bus):
    """Direct URL model selections are not fetched; startup remains fail-soft."""
    with patch("app.services.stt_wakeword.service.config_api") as mock_cfg:
        mock_cfg.aget = AsyncMock(
            return_value=Wakeword(
                backend="oww",
                threshold=0.5,
                model_path="https://models.example/aurora.onnx",
            )
        )
        with patch("app.shared.services.base_service.get_bus_singleton", return_value=mock_bus):
            service = WakeWordService()

        await service._load_config()

    assert service._model_paths == []
    assert service._wake_words == []
    assert service._readiness_status == "unavailable"
    assert service._readiness_message == "catalog_required"


@pytest.mark.asyncio
async def test_wakeword_mixed_selection_fails_full_selected_set(mock_bus, tmp_path):
    """Any invalid selected wake model makes the whole configured set unavailable."""
    local_model = tmp_path / "local.onnx"
    local_model.write_bytes(b"model")
    with patch("app.services.stt_wakeword.service.config_api") as mock_cfg:
        mock_cfg.aget = AsyncMock(
            return_value=Wakeword(
                backend="oww",
                threshold=0.5,
                model_path=f"{local_model},https://models.example/aurora.onnx",
            )
        )
        with patch("app.shared.services.base_service.get_bus_singleton", return_value=mock_bus):
            service = WakeWordService()

        await service._load_config()

    assert service._model_paths == []
    assert service._wake_words == []
    assert service._readiness_status == "unavailable"
    assert service._readiness_message == "catalog_required"


def test_wakeword_catalog_requires_sha256_size_and_https(service, tmp_path, monkeypatch):
    """Catalog entries must be allowlisted HTTPS downloads with digest metadata."""
    catalog = tmp_path / "catalog.json"
    monkeypatch.setenv(WAKEWORD_MODEL_CATALOG_ENV, str(catalog))

    catalog.write_text(
        json.dumps({"models": [{"id": "aurora", "url": "https://models.example/a.onnx"}]}),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="sha256"):
        service._catalog_entry_for_key("aurora")

    catalog.write_text(
        json.dumps(
            {
                "models": [
                    {
                        "id": "aurora",
                        "url": "http://models.example/a.onnx",
                        "sha256": "0" * 64,
                        "size_bytes": 10,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="HTTPS"):
        service._catalog_entry_for_key("aurora")


def test_wakeword_catalog_denies_private_dns(service, tmp_path, monkeypatch):
    """Catalog URL hosts resolving to private addresses are rejected before download."""
    catalog = tmp_path / "catalog.json"
    catalog.write_text(
        json.dumps(
            {
                "models": [
                    {
                        "id": "aurora",
                        "url": "https://models.example/a.onnx",
                        "sha256": "0" * 64,
                        "size_bytes": 10,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv(WAKEWORD_MODEL_CATALOG_ENV, str(catalog))
    monkeypatch.setattr(
        "app.services.stt_wakeword.service.socket.getaddrinfo",
        lambda *args, **kwargs: [
            (None, None, None, "", ("127.0.0.1", 443)),
        ],
    )

    with pytest.raises(ValueError, match="not allowed"):
        service._catalog_entry_for_key("aurora")


def test_wakeword_catalog_redirects_are_denied():
    """Catalog downloader rejects redirects instead of following a new host."""
    request = Mock(full_url="https://models.example/a.onnx")

    with pytest.raises(HTTPError, match="redirects are not allowed"):
        _NoRedirectHandler().redirect_request(
            request,
            None,
            302,
            "Found",
            {},
            "https://models.example/redirected.onnx",
        )


def test_pinned_https_connection_uses_prevalidated_ip_and_hostname_sni(monkeypatch):
    """The HTTPS socket connects to the screened IP while TLS verifies hostname/SNI."""
    created = []
    wrapped = []
    fake_socket = object()

    def fake_create_connection(address, timeout, source_address):
        created.append((address, timeout, source_address))
        return fake_socket

    class FakeContext:
        def wrap_socket(self, sock, *, server_hostname):
            wrapped.append((sock, server_hostname))
            return "tls-socket"

    monkeypatch.setattr(
        "app.services.stt_wakeword.service.socket.create_connection", fake_create_connection
    )
    connection = _PinnedIPHTTPSConnection(
        "models.example",
        port=443,
        pinned_ip="93.184.216.34",
        timeout=3,
    )
    connection._context = FakeContext()

    connection.connect()

    assert created == [(("93.184.216.34", 443), 3, None)]
    assert wrapped == [(fake_socket, "models.example")]
    assert connection.sock == "tls-socket"


@pytest.mark.asyncio
async def test_wakeword_catalog_download_uses_per_digest_lock(service, tmp_path, monkeypatch):
    """Concurrent downloads for the same digest write once and share the cache hit."""
    model_bytes = b"wakeword model bytes"
    expected_sha = hashlib.sha256(model_bytes).hexdigest()
    monkeypatch.setenv("AURORA_WAKEWORD_MODEL_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setattr(
        "app.services.stt_wakeword.service._validate_https_download_url",
        lambda _url: ("models.example", 443, "93.184.216.34"),
    )
    calls = 0

    def fake_stream(entry, destination, hostname, port, pinned_ip):
        del hostname, port, pinned_ip
        nonlocal calls
        calls += 1
        Path(destination).write_bytes(model_bytes)

    monkeypatch.setattr(service, "_stream_https_to_temp", fake_stream)
    entry = WakeWordCatalogEntry(
        key="aurora",
        url="https://models.example/aurora.onnx",
        sha256=expected_sha,
        size_bytes=len(model_bytes),
        name="aurora",
    )

    first_path, second_path = await asyncio.gather(
        service._download_model_to_cache(entry),
        service._download_model_to_cache(entry),
    )

    assert first_path == second_path
    assert calls == 1


@pytest.mark.asyncio
async def test_wakeword_cache_prunes_old_files_to_quota(service, tmp_path, monkeypatch):
    """Wakeword cache pruning removes older digest files outside the keep set."""
    model_bytes = b"fresh model bytes"
    expected_sha = hashlib.sha256(model_bytes).hexdigest()
    cache_dir = tmp_path / "cache"
    old_file = cache_dir / "aa" / ("a" * 64)
    old_file.parent.mkdir(parents=True)
    old_file.write_bytes(b"old bytes")
    monkeypatch.setenv("AURORA_WAKEWORD_MODEL_CACHE_DIR", str(cache_dir))
    monkeypatch.setenv(
        WAKEWORD_MODEL_CACHE_QUOTA_ENV,
        str(len(model_bytes) + 1),
    )
    monkeypatch.setattr(
        "app.services.stt_wakeword.service._validate_https_download_url",
        lambda _url: ("models.example", 443, "93.184.216.34"),
    )
    monkeypatch.setattr(
        service,
        "_stream_https_to_temp",
        lambda entry, destination, hostname, port, pinned_ip: Path(destination).write_bytes(
            model_bytes
        ),
    )
    entry = WakeWordCatalogEntry(
        key="aurora",
        url="https://models.example/aurora.onnx",
        sha256=expected_sha,
        size_bytes=len(model_bytes),
        name="aurora",
    )

    fresh_path = await service._download_model_to_cache(entry)

    assert Path(fresh_path).is_file()
    assert not old_file.exists()


@pytest.mark.asyncio
async def test_initialize_unknown_backend_raises_error(service):
    """Test initialization with unknown backend raises ValueError."""
    service._backend_type = Mock(value="unknown")

    with pytest.raises(ValueError, match="Unknown wake word backend"):
        await service._initialize_backend()


# ============================================================================
# Service Lifecycle Tests
# ============================================================================


@pytest.mark.asyncio
async def test_start_service(service, mock_bus):
    """Test starting the wake word service."""
    # Set backend type since we're mocking _load_config
    service._backend_type = WakeWordBackendType.OPENWAKEWORD

    load_config = AsyncMock(spec=service._load_config)
    initialize_backend = AsyncMock(spec=service._initialize_backend)

    with (
        patch.object(service, "_load_config", new=load_config),
        patch.object(service, "_initialize_backend", new=initialize_backend),
    ):
        initialize_backend.side_effect = lambda: setattr(service, "_backend", Mock())
        await service.start()

        assert service._running is True
        assert service._enabled is True

        # Verify subscriptions - at least the microphone stream
        mock_bus.subscribe_event.assert_any_await(
            AudioTopics.STREAM_MICROPHONE, service._on_audio_chunk
        )


@pytest.mark.asyncio
async def test_stop_service(service):
    """Test stopping the wake word service."""
    # Setup service with a backend
    mock_backend = AsyncMock()
    mock_backend.cleanup = AsyncMock()
    service._backend = mock_backend
    service._running = True
    service._enabled = True
    service._started = True

    await service.stop()

    assert service._running is False
    assert service._enabled is False
    assert service._backend is None
    mock_backend.cleanup.assert_awaited_once()


@pytest.mark.asyncio
async def test_stop_service_without_backend(service):
    """Test stopping service when no backend is initialized."""
    service._running = True
    service._enabled = True
    service._backend = None
    service._started = True

    # Should not raise error
    await service.stop()

    assert service._running is False
    assert service._enabled is False


# ============================================================================
# Audio Processing Tests
# ============================================================================


@pytest.mark.asyncio
async def test_on_audio_chunk_when_enabled(service, mock_backend):
    """Test audio chunk processing when service is enabled."""
    service._enabled = True
    service._backend = mock_backend
    mark_wakeword_ready(service)

    # Create mock detection result
    mock_result = Mock()
    mock_result.detected = False
    mock_backend.detect.return_value = mock_result

    chunk = AudioChunk(
        data=b"audio_data",
        stream_id="test-stream",
        source="microphone",
        sequence=0,
        format=AudioFormat(sample_rate=16000, channels=1, bits_per_sample=16),
    )
    envelope = Envelope(type="event", payload=chunk)

    await service._on_audio_chunk(envelope)

    # Verify backend detect was called
    mock_backend.detect.assert_called_once_with(b"audio_data")

    # Verify stream tracking
    assert service._current_stream_id == "test-stream"
    assert service._current_source == "microphone"
    assert service._audio_format is not None


@pytest.mark.asyncio
async def test_on_audio_chunk_when_disabled(service, mock_backend):
    """Test audio chunk is ignored when service is disabled."""
    service._enabled = False
    service._backend = mock_backend

    chunk = AudioChunk(data=b"audio_data", sequence=0, stream_id="test-stream", source="microphone")
    envelope = Envelope(type="event", payload=chunk)

    await service._on_audio_chunk(envelope)

    # Verify backend detect was NOT called
    mock_backend.detect.assert_not_called()


@pytest.mark.asyncio
async def test_on_audio_chunk_without_backend(service):
    """Test audio chunk is ignored when backend is not initialized."""
    service._enabled = True
    service._backend = None

    chunk = AudioChunk(data=b"audio_data", sequence=0, stream_id="test-stream", source="microphone")
    envelope = Envelope(type="event", payload=chunk)

    # Should not raise error
    await service._on_audio_chunk(envelope)


@pytest.mark.asyncio
async def test_on_audio_chunk_with_exception(service, mock_backend):
    """Test audio chunk processing handles exceptions gracefully."""
    service._enabled = True
    service._backend = mock_backend
    mark_wakeword_ready(service)
    mock_backend.detect.side_effect = Exception("Detection error")

    chunk = AudioChunk(data=b"audio_data", sequence=0, stream_id="test-stream", source="microphone")
    envelope = Envelope(type="event", payload=chunk)

    # Should not raise exception
    await service._on_audio_chunk(envelope)


# ============================================================================
# Wake Word Detection Tests
# ============================================================================


@pytest.mark.asyncio
async def test_wake_word_detected_emits_event(service, mock_backend, mock_bus):
    """Test wake word detection emits WakeWordDetected event."""
    service._enabled = True
    service._backend = mock_backend
    mark_wakeword_ready(service)
    service._wake_words = ["aurora", "jarvis"]
    service._backend_type = WakeWordBackendType.OPENWAKEWORD

    # Create mock detection result with detection
    mock_result = Mock()
    mock_result.detected = True
    mock_result.wake_word_index = 0
    mock_result.confidence = 0.95
    mock_backend.detect.return_value = mock_result

    chunk = AudioChunk(data=b"audio_data", sequence=0, stream_id="test-stream", source="microphone")
    envelope = Envelope(type="event", payload=chunk)

    await service._on_audio_chunk(envelope)

    # Verify event was published
    mock_bus.publish.assert_called_once()
    call_args = mock_bus.publish.call_args

    assert call_args[0][0] == WakeWordMethods.DETECTED
    event = call_args[0][1]
    assert isinstance(event, WakeWordDetected)
    assert event.wake_word == "aurora"
    assert event.confidence == 0.95
    assert event.source == "microphone"
    assert event.stream_id == "test-stream"
    assert event.backend == WakeWordBackendType.OPENWAKEWORD
    assert not hasattr(event, "metadata")


@pytest.mark.asyncio
async def test_wake_word_not_detected_no_event(service, mock_backend, mock_bus):
    """Test no event is emitted when wake word is not detected."""
    service._enabled = True
    service._backend = mock_backend
    mark_wakeword_ready(service)

    # Create mock detection result without detection
    mock_result = Mock()
    mock_result.detected = False
    mock_backend.detect.return_value = mock_result

    chunk = AudioChunk(data=b"audio_data", sequence=0, stream_id="test-stream", source="microphone")
    envelope = Envelope(type="event", payload=chunk)

    await service._on_audio_chunk(envelope)

    # Verify no event was published
    mock_bus.publish.assert_not_called()


@pytest.mark.asyncio
async def test_wake_word_detection_with_multiple_models(service, mock_backend, mock_bus):
    """Test wake word detection with multiple wake word models."""
    service._enabled = True
    service._backend = mock_backend
    mark_wakeword_ready(service)
    service._wake_words = ["aurora", "jarvis", "computer"]
    service._backend_type = WakeWordBackendType.PORCUPINE

    # Detect second wake word
    mock_result = Mock()
    mock_result.detected = True
    mock_result.wake_word_index = 1
    mock_result.confidence = 0.88
    mock_backend.detect.return_value = mock_result

    chunk = AudioChunk(data=b"audio_data", sequence=0, stream_id="test-stream", source="microphone")
    envelope = Envelope(type="event", payload=chunk)

    await service._on_audio_chunk(envelope)

    # Verify correct wake word was published
    call_args = mock_bus.publish.call_args
    event = call_args[0][1]
    assert event.wake_word == "jarvis"


# ============================================================================
# Control Command Tests
# ============================================================================


@pytest.mark.asyncio
async def test_control_command_start(service):
    """Test start control command enables detection."""
    service._enabled = False
    service._backend = Mock()
    mark_wakeword_ready(service)

    cmd = WakeWordControl(action="start")

    await service._on_control(cmd)

    assert service._enabled is True


@pytest.mark.asyncio
async def test_control_command_stop(service):
    """Test stop control command disables detection."""
    service._enabled = True

    cmd = WakeWordControl(action="stop")

    await service._on_control(cmd)

    assert service._enabled is False


@pytest.mark.asyncio
async def test_control_command_pause(service):
    """Test pause control command disables detection."""
    service._enabled = True

    cmd = WakeWordControl(action="pause")

    await service._on_control(cmd)

    assert service._enabled is False


@pytest.mark.asyncio
async def test_control_command_resume(service):
    """Test resume control command enables detection."""
    service._enabled = False
    service._backend = Mock()
    mark_wakeword_ready(service)

    cmd = WakeWordControl(action="resume")

    await service._on_control(cmd)

    assert service._enabled is True


@pytest.mark.asyncio
async def test_control_command_case_insensitive(service):
    """Test control commands are case-insensitive."""
    service._enabled = False
    service._backend = Mock()
    mark_wakeword_ready(service)

    cmd = WakeWordControl(action="START")

    await service._on_control(cmd)

    assert service._enabled is True


@pytest.mark.asyncio
async def test_control_command_unknown_action(service):
    """Test unknown control action is handled gracefully."""
    initial_state = service._enabled

    cmd = WakeWordControl(action="unknown_action")
    envelope = Envelope(type="command", payload=cmd)

    # Should not raise exception
    await service._on_control(envelope)

    # State should not change
    assert service._enabled == initial_state


@pytest.mark.asyncio
async def test_control_command_with_exception(service):
    """Test control command handling with exception."""
    # Create an invalid control command that will cause attribute access error
    # Use a WakeWordControl with action that causes exception during processing
    cmd = WakeWordControl(action="test")

    # Patch to make the action processing raise an exception
    with patch.object(service, "_enabled", side_effect=Exception("Test exception")):
        envelope = Envelope(type="command", payload=cmd)

        # Should not raise exception - errors are caught and logged
        await service._on_control(envelope)


# ============================================================================
# Error Handling Tests
# ============================================================================


@pytest.mark.asyncio
async def test_process_audio_chunk_with_detection_error(service, mock_backend, mock_bus):
    """Test error handling during wake word detection."""
    service._enabled = True
    service._backend = mock_backend
    mark_wakeword_ready(service)
    mock_backend.detect.side_effect = Exception("Backend error")

    chunk = AudioChunk(data=b"audio_data", sequence=0, stream_id="test-stream", source="microphone")

    # Should not raise exception
    await service._process_audio_chunk(chunk)

    # No event should be published due to error
    mock_bus.publish.assert_not_called()


@pytest.mark.asyncio
async def test_external_detect_error_is_generic(service, mock_backend):
    """Backend detection errors never expose exception text or selected paths externally."""
    service._enabled = True
    service._backend = mock_backend
    mark_wakeword_ready(service)
    raw_detail = "backend failed for /private/models/jarvis.onnx"
    mock_backend.detect.side_effect = RuntimeError(raw_detail)
    logged: list[tuple[str, tuple[object, ...]]] = []

    with (
        patch(
            "app.services.stt_wakeword.service.log_warning",
            side_effect=lambda message, *args, **kwargs: logged.append((str(message), args)),
        ),
        pytest.raises(RuntimeError) as exc_info,
    ):
        await service.detect_wake_word(
            WakeWordDetectRequest(audio_data=base64.b64encode(b"audio").decode("ascii"))
        )

    assert str(exc_info.value) == "Wake word detection failed"
    assert raw_detail not in str(exc_info.value)
    assert logged == [("Wake word detection request failed: %s", ("backend_error",))]
    assert raw_detail not in str(logged)


# ============================================================================
# Stream Tracking Tests
# ============================================================================


@pytest.mark.asyncio
async def test_stream_id_tracking(service, mock_backend):
    """Test service tracks current stream ID."""
    service._enabled = True
    service._backend = mock_backend
    mark_wakeword_ready(service)
    mock_backend.detect.return_value = Mock(detected=False)

    chunk1 = AudioChunk(data=b"data1", sequence=0, stream_id="stream-1", source="mic")
    envelope1 = Envelope(type="event", payload=chunk1)
    await service._on_audio_chunk(envelope1)

    assert service._current_stream_id == "stream-1"
    assert service._current_source == "mic"

    chunk2 = AudioChunk(data=b"data2", sequence=0, stream_id="stream-2", source="file")
    envelope2 = Envelope(type="event", payload=chunk2)
    await service._on_audio_chunk(envelope2)

    assert service._current_stream_id == "stream-2"
    assert service._current_source == "file"


@pytest.mark.asyncio
async def test_audio_format_tracking(service, mock_backend):
    """Test service tracks audio format."""
    service._enabled = True
    service._backend = mock_backend
    mark_wakeword_ready(service)
    mock_backend.detect.return_value = Mock(detected=False)

    audio_format = AudioFormat(sample_rate=16000, channels=1, bits_per_sample=16)
    chunk = AudioChunk(
        data=b"audio_data",
        sequence=0,
        stream_id="test-stream",
        source="microphone",
        format=audio_format,
    )
    envelope = Envelope(type="event", payload=chunk)

    await service._on_audio_chunk(envelope)

    assert service._audio_format == audio_format
    assert service._audio_format.sample_rate == 16000
    assert service._audio_format.channels == 1
    assert service._audio_format.bits_per_sample == 16
