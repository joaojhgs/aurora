"""Regression locks for the current Piper-backed TTS service behavior."""

from __future__ import annotations

import asyncio
import base64
import io
import sys
import types
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from app.services.tts.piper_catalog import (
    CATALOG_REVISION,
    PiperCatalogInstallResult,
    PiperCatalogVoice,
    PiperResolvedVoice,
)
from app.services.tts.providers.base import (
    TTSProviderCapabilities,
    TTSProviderError,
    TTSProviderHealth,
    TTSSynthesisResult,
    TTSVoiceInfo,
    VoiceSelectionMode,
)
from app.services.tts.providers.piper import PiperTTSProvider
from app.services.tts.service import TTSService
from app.shared.config.models import Piper, Providers, Tts
from app.shared.contracts.models.common import EmptyInput
from app.shared.contracts.models.gateway import GatewayMethods
from app.shared.contracts.models.tts import (
    TTSInstallVoiceProfileRequest,
    TTSListLanguagePacksRequest,
    TTSMethods,
    TTSRemoveVoiceProfileRequest,
    TTSRequest,
    TTSSetDefaultVoiceRequest,
    TTSSynthesizeRequest,
)
from app.shared.messaging import bus_init


@pytest.fixture
def mock_bus():
    bus = Mock()
    bus.publish = AsyncMock()
    bus.subscribe = Mock()
    bus.subscribe_event = AsyncMock()
    bus.unsubscribe = Mock()
    bus_init.set_bus(bus)
    yield bus
    bus_init._bus = None
    bus_init._service_buses.clear()


@pytest.fixture
def service(mock_bus):
    svc = TTSService()
    svc.stream = Mock()
    svc.stream.stop = Mock()
    svc.stream.pause = Mock()
    svc.stream.resume = Mock()
    svc.stream.feed = Mock()
    svc.stream.play_async = Mock()
    return svc


@pytest.fixture
def fake_realtimetts(monkeypatch):
    module = types.ModuleType("RealtimeTTS")

    class PiperVoice:
        def __init__(self, *, model_file: str, config_file: str | None = None) -> None:
            self.model_file = model_file
            self.config_file = config_file

    class TextToAudioStream:
        instances: list[TextToAudioStream] = []

        def __init__(self, engine, **kwargs) -> None:
            self.engine = engine
            self.kwargs = kwargs
            self.stop = Mock()
            self.pause = Mock()
            self.resume = Mock()
            self.feed = Mock()
            self.play_async = Mock()
            self.__class__.instances.append(self)

    module.PiperVoice = PiperVoice
    module.TextToAudioStream = TextToAudioStream
    monkeypatch.setitem(sys.modules, "RealtimeTTS", module)
    return module


@pytest.fixture
def fake_piper_engine(monkeypatch):
    module = types.ModuleType("app.services.tts.piper_engine")

    class PiperEngine:
        instances: list[PiperEngine] = []

        def __init__(self, *, piper_path, voice, sample_rate) -> None:
            self.piper_path = piper_path
            self.voice = voice
            self._sample_rate = sample_rate
            self._use_cuda = "disabled"
            self.__class__.instances.append(self)

    module.PiperEngine = PiperEngine
    monkeypatch.setitem(sys.modules, "app.services.tts.piper_engine", module)
    return module


def _decode_wav(encoded_audio: str) -> tuple[bytes, int, int, int]:
    with wave.open(io.BytesIO(base64.b64decode(encoded_audio)), "rb") as wav_file:
        return (
            wav_file.readframes(wav_file.getnframes()),
            wav_file.getframerate(),
            wav_file.getnchannels(),
            wav_file.getsampwidth(),
        )


def _resolved_piper_voice(tmp_path: Path) -> PiperResolvedVoice:
    model = tmp_path / "voice.onnx"
    config = tmp_path / "voice.onnx.json"
    tokens = tmp_path / "tokens.txt"
    data_dir = tmp_path / "espeak-ng-data"
    model.write_bytes(b"model")
    config.write_text('{"audio": {"sample_rate": 16000}}', encoding="utf-8")
    tokens.write_text("a\nb\n", encoding="utf-8")
    data_dir.mkdir()
    return PiperResolvedVoice(
        voice_id="standard:piper:en_us-test-low",
        display_name="Test low",
        language="en-us",
        revision=CATALOG_REVISION,
        model_file=model,
        config_file=config,
        tokens_file=tokens,
        data_dir=data_dir,
        sample_rate=16000,
    )


class FakeProvider:
    """Minimal provider double for service-boundary tests."""

    def __init__(self, *, audio: bytes = b"\x01\x00\x02\x00", sample_rate: int = 22050):
        self.requests = []
        self.audio = audio
        self.sample_rate = sample_rate
        self.stopped = False
        self.voices = (TTSVoiceInfo("default", "Default", True),)

    @property
    def capabilities(self) -> TTSProviderCapabilities:
        return TTSProviderCapabilities(
            provider_id="fake",
            voice_selection_mode=VoiceSelectionMode.ACTIVE_ONLY,
        )

    async def start(self) -> None:
        pass

    async def stop(self) -> None:
        self.stopped = True

    async def health(self) -> TTSProviderHealth:
        return TTSProviderHealth("fake", True, "default", "fake:base")

    async def list_voices(self):
        return self.voices

    async def synthesize(self, request) -> TTSSynthesisResult:
        self.requests.append(request)
        if request.voice == "standard:test:missing":
            raise TTSProviderError("unsupported_voice", "Requested voice is unavailable")
        return TTSSynthesisResult(
            audio=self.audio,
            audio_format=request.audio_format,
            sample_rate=self.sample_rate,
            channels=1,
            duration_ms=(len(self.audio) / (self.sample_rate * 2)) * 1000,
            voice=request.voice or "default",
        )

    def stream(self, request):
        raise NotImplementedError

    async def cancel(self, request_id: str) -> None:
        pass


class FakePiperCatalogManager:
    def __init__(self, resolved_voice: PiperResolvedVoice | None = None) -> None:
        self.resolved_voice = resolved_voice
        self.installed = resolved_voice is not None
        self.installed_voice_ids: list[str] = []
        self.removed_voice_ids: list[str] = []
        self.voices = (
            PiperCatalogVoice(
                voice_id="standard:piper:en_us-test-low",
                display_name="Test low",
                language="en-us",
                revision=CATALOG_REVISION,
                installed=self.installed,
                ready=self.installed,
                sample_rate=16000 if self.installed else None,
            ),
            PiperCatalogVoice(
                voice_id="standard:piper:fr_fr-test-low",
                display_name="Test French",
                language="fr-fr",
                revision=CATALOG_REVISION,
                installed=False,
                ready=False,
                sample_rate=None,
            ),
        )

    async def list_voices(self):
        return self.voices

    async def install_voice(self, voice_id: str) -> PiperCatalogInstallResult:
        self.installed_voice_ids.append(voice_id)
        assert self.resolved_voice is not None
        self.installed = True
        self.voices = (
            self.voices[0].__class__(
                voice_id=self.voices[0].voice_id,
                display_name=self.voices[0].display_name,
                language=self.voices[0].language,
                revision=self.voices[0].revision,
                installed=True,
                ready=True,
                sample_rate=16000,
            ),
            self.voices[1],
        )
        return PiperCatalogInstallResult(voice=self.resolved_voice, reused_cached_archive=False)

    async def remove_voice(self, voice_id: str) -> bool:
        self.removed_voice_ids.append(voice_id)
        return True

    async def resolve_voice(self, voice_id: str) -> PiperResolvedVoice:
        assert self.resolved_voice is not None
        assert voice_id == self.resolved_voice.voice_id
        return self.resolved_voice


@pytest.mark.asyncio
async def test_synthesize_returns_golden_wav_container_for_piper_pcm(
    service: TTSService, monkeypatch
) -> None:
    """returns a mono 16-bit WAV container when Piper finite synthesis requests wav."""
    pcm = b"\x01\x00\x02\x00\x03\x00\x04\x00"

    async def synthesize(text: str, **kwargs) -> tuple[bytes, int]:
        assert text == "golden text"
        return pcm, 22050

    monkeypatch.setattr(service, "_synthesize_to_bytes", synthesize)

    response = await service.synthesize(TTSSynthesizeRequest(text="golden text", format="wav"))

    assert response.format == "wav"
    assert response.sample_rate == 22050
    assert response.channels == 1
    assert response.duration_ms == pytest.approx(4 / 22050 * 1000)
    assert _decode_wav(response.audio_data) == (pcm, 22050, 1, 2)


@pytest.mark.asyncio
async def test_synthesize_returns_golden_raw_pcm_for_piper_pcm(
    service: TTSService, monkeypatch
) -> None:
    """returns raw PCM bytes when Piper finite synthesis requests raw."""
    pcm = b"\x10\x00\x20\x00"

    async def synthesize(_text: str, **kwargs) -> tuple[bytes, int]:
        return pcm, 24000

    monkeypatch.setattr(service, "_synthesize_to_bytes", synthesize)

    response = await service.synthesize(TTSSynthesizeRequest(text="raw text", format="raw"))

    assert response.format == "raw"
    assert response.sample_rate == 24000
    assert base64.b64decode(response.audio_data) == pcm
    assert response.duration_ms == pytest.approx(2 / 24000 * 1000)


@pytest.mark.asyncio
async def test_synthesize_routes_voice_speed_and_sample_rate_to_provider(
    service: TTSService,
) -> None:
    """sends logical voice and synthesis options through the provider boundary."""
    provider = FakeProvider(audio=b"\x05\x00\x06\x00", sample_rate=16000)
    service._provider = provider

    audio, sample_rate = await service._synthesize_to_bytes(
        "threaded",
        request_id="request-1",
        voice="voice-a",
        sample_rate=24000,
        speed=0.75,
    )

    assert audio == b"\x05\x00\x06\x00"
    assert sample_rate == 16000
    assert provider.requests[-1].text == "threaded"
    assert provider.requests[-1].request_id == "request-1"
    assert provider.requests[-1].voice == "voice-a"
    assert provider.requests[-1].sample_rate == 24000
    assert provider.requests[-1].speed == 0.75


@pytest.mark.asyncio
async def test_synthesize_maps_piper_failure_without_echoing_request_text(
    service: TTSService,
) -> None:
    """maps Piper failures without including the requested text in the error."""
    service._provider = FakeProvider()

    with pytest.raises(RuntimeError) as exc_info:
        await service.synthesize(
            TTSSynthesizeRequest(text="private words", voice="standard:test:missing", format="wav")
        )

    assert str(exc_info.value) == "TTS voice is unavailable"
    assert "private words" not in str(exc_info.value)


@pytest.mark.asyncio
async def test_tts_request_error_event_does_not_include_request_text(
    service: TTSService, mock_bus, monkeypatch
) -> None:
    """publishes a TTS error event without copying request text into the payload."""

    async def fail_playback(_text: str, _request_id: str, **kwargs) -> None:
        raise RuntimeError("audio output unavailable")

    monkeypatch.setattr(service, "_play_text", fail_playback)

    await service._on_tts_request(TTSRequest(text="do not echo this"))

    error_call = next(
        call for call in mock_bus.publish.await_args_list if call.args[0] == TTSMethods.ERROR
    )
    assert error_call.args[1].error == "TTS request failed"
    assert not hasattr(error_call.args[1], "text")
    assert error_call.kwargs["event"] is True
    assert error_call.kwargs["mesh"] is False


@pytest.mark.asyncio
async def test_tts_request_validates_requested_voice_before_server_playback(
    service: TTSService, mock_bus
) -> None:
    """routes server playback voice selection through the active provider."""
    service._provider = FakeProvider()

    await service._on_tts_request(TTSRequest(text="hello", voice="standard:test:missing"))

    service.stream.feed.assert_not_called()
    error_call = next(
        call for call in mock_bus.publish.await_args_list if call.args[0] == TTSMethods.ERROR
    )
    assert error_call.args[1].error == "TTS voice is unavailable"
    assert not hasattr(error_call.args[1], "text")


@pytest.mark.asyncio
async def test_pause_controls_current_playback(service: TTSService, mock_bus) -> None:
    """pauses active playback and emits the typed paused event."""
    service._playing = True

    await service._on_pause(EmptyInput())

    assert service._paused is True
    service.stream.pause.assert_called_once_with()
    paused_call = next(
        call for call in mock_bus.publish.await_args_list if call.args[0] == TTSMethods.PAUSED
    )
    assert paused_call.kwargs["event"] is True
    assert paused_call.kwargs["mesh"] is False


@pytest.mark.asyncio
async def test_resume_controls_paused_playback(service: TTSService, mock_bus) -> None:
    """resumes paused playback and emits the typed resumed event."""
    service._playing = True
    service._paused = True

    await service._on_resume(EmptyInput())

    assert service._paused is False
    service.stream.resume.assert_called_once_with()
    resumed_call = next(
        call for call in mock_bus.publish.await_args_list if call.args[0] == TTSMethods.RESUMED
    )
    assert resumed_call.kwargs["event"] is True
    assert resumed_call.kwargs["mesh"] is False


@pytest.mark.asyncio
async def test_get_model_paths_prefers_nested_piper_config_over_legacy_flat(
    service: TTSService, tmp_path
) -> None:
    """uses canonical provider paths instead of legacy flat compatibility fields."""
    nested_model = tmp_path / "nested.onnx"
    nested_config = tmp_path / "nested.onnx.json"
    flat_model = tmp_path / "flat.onnx"
    flat_config = tmp_path / "flat.onnx.json"
    nested_model.write_bytes(b"nested")
    nested_config.write_text("{}", encoding="utf-8")
    flat_model.write_bytes(b"flat")
    flat_config.write_text("{}", encoding="utf-8")
    tts_cfg = Tts(
        model_file_path=str(flat_model),
        model_config_file_path=str(flat_config),
        providers=Providers(
            piper=Piper(
                model_file_path=str(nested_model),
                model_config_file_path=str(nested_config),
            )
        ),
    )

    model_path, config_path = await service._get_model_paths(tts_cfg)

    assert model_path == str(nested_model)
    assert config_path == str(nested_config)


@pytest.mark.asyncio
async def test_start_initializes_piper_stream_from_nested_piper_config(
    service: TTSService,
    fake_realtimetts,
    fake_piper_engine,
    monkeypatch,
    tmp_path,
) -> None:
    """starts Piper from canonical nested config and ignores legacy flat values."""
    nested_model = tmp_path / "nested.onnx"
    nested_config = tmp_path / "nested.onnx.json"
    nested_model.write_bytes(b"model")
    nested_config.write_text('{"audio": {"sample_rate": 16000}}', encoding="utf-8")
    flat_model = tmp_path / "flat.onnx"
    flat_config = tmp_path / "flat.onnx.json"

    async def fake_config(*_args, **_kwargs):
        return Tts(
            default_voice_id="nested-voice",
            hardware_acceleration=False,
            model_file_path=str(flat_model),
            model_config_file_path=str(flat_config),
            model_sample_rate=8000,
            piper_path="/legacy/piper",
            providers=Providers(
                piper=Piper(
                    model_file_path=str(nested_model),
                    model_config_file_path=str(nested_config),
                    model_sample_rate=16000,
                    executable_path="/opt/nested-piper",
                )
            ),
        )

    monkeypatch.setattr("app.services.tts.service.config_api.aget", fake_config)
    monkeypatch.setattr("app.services.tts.service.shutil.which", lambda _name: None)

    await service.on_start()

    engine = fake_piper_engine.PiperEngine.instances[-1]
    stream = fake_realtimetts.TextToAudioStream.instances[-1]
    assert service._loop is asyncio.get_running_loop()
    assert isinstance(service._provider, PiperTTSProvider)
    assert service._provider._voice.expected_sample_rate == 16000
    assert engine.piper_path == "/opt/nested-piper"
    assert engine.voice.model_file == str(nested_model)
    assert engine.voice.config_file == str(nested_config)
    assert engine._sample_rate == 16000
    assert stream.engine is engine

    await service.on_stop()

    stream.stop.assert_called_once_with()
    assert service._provider is None


@pytest.mark.asyncio
async def test_piper_list_language_packs_exposes_catalog_voices_even_uninstalled(
    service: TTSService, monkeypatch, tmp_path: Path
) -> None:
    """shows pinned Piper catalog voices through language packs without installing them."""
    manager = FakePiperCatalogManager()

    async def fake_config(*_args, **_kwargs):
        return Tts(provider="piper", providers=Providers(piper=Piper(cache_dir=str(tmp_path))))

    monkeypatch.setattr("app.services.tts.service.config_api.aget", fake_config)
    monkeypatch.setattr(service, "_piper_catalog_manager", lambda _cfg: manager)

    response = await service.list_language_packs(TTSListLanguagePacksRequest())

    assert [pack.pack_id for pack in response.packs] == ["en-us", "fr-fr"]
    assert response.packs[0].voices[0].voice_id == "standard:piper:en_us-test-low"
    assert response.packs[0].voices[0].installed is False
    assert response.catalog_status == "available"


@pytest.mark.asyncio
async def test_piper_install_checks_catalog_revision_and_installs_exact_voice(
    service: TTSService, monkeypatch, tmp_path: Path
) -> None:
    """uses the Piper catalog manager for exact selected-voice installs."""
    manager = FakePiperCatalogManager(_resolved_piper_voice(tmp_path))
    manager.installed = False
    manager.voices = (
        PiperCatalogVoice(
            voice_id="standard:piper:en_us-test-low",
            display_name="Test low",
            language="en-us",
            revision=CATALOG_REVISION,
            installed=False,
            ready=False,
            sample_rate=None,
        ),
        manager.voices[1],
    )

    async def fake_config(*_args, **_kwargs):
        return Tts(provider="piper", providers=Providers(piper=Piper(cache_dir=str(tmp_path))))

    async def noop_audit(*_args, **_kwargs):
        return None

    monkeypatch.setattr("app.services.tts.service.config_api.aget", fake_config)
    monkeypatch.setattr(service, "_piper_catalog_manager", lambda _cfg: manager)
    monkeypatch.setattr(service, "_audit_voice_management", noop_audit)
    monkeypatch.setattr(service, "_initialize_engine_fail_soft", AsyncMock(return_value=True))

    conflict = await service.install_voice_profile(
        TTSInstallVoiceProfileRequest(
            voice_id="standard:piper:en_us-test-low",
            operation_id="install-conflict",
            expected_revision="older",
        )
    )
    installed = await service.install_voice_profile(
        TTSInstallVoiceProfileRequest(
            voice_id="standard:piper:en_us-test-low",
            operation_id="install-ok",
            expected_revision=CATALOG_REVISION,
        )
    )

    assert conflict.status == "revision_conflict"
    assert installed.status == "installed"
    assert installed.revision == CATALOG_REVISION
    assert manager.installed_voice_ids == ["standard:piper:en_us-test-low"]


@pytest.mark.asyncio
async def test_piper_set_default_persists_and_runtime_binds_selected_receipt(
    service: TTSService,
    fake_realtimetts,
    fake_piper_engine,
    monkeypatch,
    tmp_path: Path,
) -> None:
    """activates an installed exact Piper voice and binds runtime to receipt paths."""
    resolved = _resolved_piper_voice(tmp_path)
    manager = FakePiperCatalogManager(resolved)
    default_voice_id: str | None = None

    async def fake_config(*_args, **_kwargs):
        return Tts(
            provider="piper",
            default_voice_id=default_voice_id,
            providers=Providers(
                piper=Piper(cache_dir=str(tmp_path), executable_path="/opt/nested-piper")
            ),
        )

    async def update_config(_path: str, value: str | None, **_kwargs):
        nonlocal default_voice_id
        default_voice_id = value
        return True

    async def noop_audit(*_args, **_kwargs):
        return None

    monkeypatch.setattr("app.services.tts.service.config_api.aget", fake_config)
    monkeypatch.setattr("app.services.tts.service.config_api.aupdate_config", update_config)
    monkeypatch.setattr(service, "_piper_catalog_manager", lambda _cfg: manager)
    monkeypatch.setattr(service, "_audit_voice_management", noop_audit)
    monkeypatch.setattr("app.services.tts.service.shutil.which", lambda _name: None)

    response = await service.set_default_voice(
        TTSSetDefaultVoiceRequest(
            voice_id=resolved.voice_id,
            operation_id="default-ok",
            expected_revision=CATALOG_REVISION,
        )
    )

    engine = fake_piper_engine.PiperEngine.instances[-1]
    assert response.status == "activated"
    assert engine.voice.model_file == str(resolved.model_file)
    assert engine.voice.config_file == str(resolved.config_file)
    assert service._provider._voice.voice_id == resolved.voice_id
    assert engine._sample_rate == 16000


@pytest.mark.asyncio
async def test_piper_remove_uses_manager_and_preserves_pockettts_registry(
    service: TTSService, monkeypatch, tmp_path: Path
) -> None:
    """removes Piper installed artifacts through the Piper manager, not VoiceRegistry."""
    resolved = _resolved_piper_voice(tmp_path)
    manager = FakePiperCatalogManager(resolved)

    async def fake_config(*_args, **_kwargs):
        return Tts(
            provider="piper",
            default_voice_id=resolved.voice_id,
            providers=Providers(piper=Piper(cache_dir=str(tmp_path))),
        )

    async def noop_audit(*_args, **_kwargs):
        return None

    monkeypatch.setattr("app.services.tts.service.config_api.aget", fake_config)
    monkeypatch.setattr(
        "app.services.tts.service.config_api.aupdate_config", AsyncMock(return_value=True)
    )
    monkeypatch.setattr(service, "_piper_catalog_manager", lambda _cfg: manager)
    monkeypatch.setattr(service, "_audit_voice_management", noop_audit)
    monkeypatch.setattr(service, "_voice_registry", Mock(side_effect=AssertionError("wrong registry")))
    monkeypatch.setattr(service, "_initialize_engine_fail_soft", AsyncMock(return_value=False))

    response = await service.remove_voice_profile(
        TTSRemoveVoiceProfileRequest(
            voice_id=resolved.voice_id,
            operation_id="remove-ok",
            expected_revision=CATALOG_REVISION,
        )
    )

    assert response.status == "drained"
    assert manager.removed_voice_ids == [resolved.voice_id]


@pytest.mark.asyncio
async def test_build_runtime_stops_started_provider_when_stream_construction_fails(
    service: TTSService, monkeypatch, tmp_path: Path
) -> None:
    """cleans up the replacement provider if local playback stream construction fails."""
    new_provider = FakeProvider()
    model = tmp_path / "voice.onnx"
    config = tmp_path / "voice.onnx.json"
    model.write_bytes(b"model")
    config.write_text('{"audio": {"sample_rate": 22050}}', encoding="utf-8")

    async def fake_model_paths(_tts_cfg):
        return str(model), str(config)

    async def fake_config(*_args, **_kwargs):
        return Tts(providers=Providers(piper=Piper()))

    def fail_stream(**_kwargs):
        raise RuntimeError("stream unavailable")

    monkeypatch.setattr("app.services.tts.service.config_api.aget", fake_config)
    monkeypatch.setattr(service, "_get_model_paths", fake_model_paths)
    monkeypatch.setattr(
        "app.services.tts.service.PiperTTSProvider",
        lambda **_kwargs: new_provider,
    )
    monkeypatch.setattr("app.services.tts.service.create_realtime_piper_stream", fail_stream)

    with pytest.raises(RuntimeError, match="stream unavailable"):
        await service._build_runtime()

    assert new_provider.stopped is True
    assert service._provider is None


@pytest.mark.asyncio
async def test_failed_reload_keeps_existing_provider_and_stream(
    service: TTSService, monkeypatch
) -> None:
    """does not tear down a healthy runtime when replacement construction fails."""
    old_provider = FakeProvider()
    old_stream = Mock()
    old_stream.stop = Mock()
    service._provider = old_provider
    service.stream = old_stream
    service.engine = object()
    service._playing = True
    service._current_request_id = "playing"

    async def fail_build_runtime():
        raise RuntimeError("new config invalid")

    monkeypatch.setattr(service, "_build_runtime", fail_build_runtime)

    await service.reload("services.tts")

    assert service._provider is old_provider
    assert service.stream is old_stream
    assert old_provider.stopped is False
    old_stream.stop.assert_not_called()
    assert service._playing is True


@pytest.mark.asyncio
async def test_reload_stops_new_provider_and_keeps_old_runtime_on_pre_swap_failure(
    service: TTSService, monkeypatch
) -> None:
    """retains the active runtime and stops the replacement if reload fails before swap."""
    old_provider = FakeProvider()
    new_provider = FakeProvider()
    old_engine = object()
    new_engine = object()
    old_stream = Mock()
    old_stream.stop = Mock()
    new_stream = Mock()
    service._provider = old_provider
    service.engine = old_engine
    service.stream = old_stream
    service._playing = True
    service._paused = True
    service._current_request_id = "playing"

    async def build_runtime():
        return new_provider, new_engine, new_stream

    async def fail_clear(_reason: str):
        raise RuntimeError("clear failed")

    monkeypatch.setattr(service, "_build_runtime", build_runtime)
    monkeypatch.setattr(service, "_clear_tts_streams", fail_clear)

    await service.reload("services.tts")

    assert service._provider is old_provider
    assert service.engine is old_engine
    assert service.stream is old_stream
    assert old_provider.stopped is False
    assert new_provider.stopped is True
    old_stream.stop.assert_not_called()
    assert service._playing is True
    assert service._paused is True
    assert service._current_request_id == "playing"


@pytest.mark.asyncio
async def test_base_service_thread_lifecycle_subscribes_and_departures(
    mock_bus,
    fake_realtimetts,
    fake_piper_engine,
    monkeypatch,
) -> None:
    """uses BaseService start/stop lifecycle for TTS in thread mode."""
    service = TTSService()

    async def fake_initialize_engine() -> None:
        service.stream = Mock()
        service.stream.stop = Mock()

    async def runtime_enabled() -> bool:
        return True

    monkeypatch.setattr(service, "_initialize_engine", fake_initialize_engine)
    monkeypatch.setattr(service, "_is_runtime_enabled", runtime_enabled)

    await service.start()
    await service.stop()

    subscribed_topics = [call.args[0] for call in mock_bus.subscribe.call_args_list]
    unsubscribed_topics = [call.args[0] for call in mock_bus.unsubscribe.call_args_list]
    published_topics = [call.args[0] for call in mock_bus.publish.await_args_list]
    assert TTSMethods.REQUEST in subscribed_topics
    assert TTSMethods.SYNTHESIZE in subscribed_topics
    assert TTSMethods.STREAM_START in subscribed_topics
    assert TTSMethods.STOP in subscribed_topics
    assert TTSMethods.REQUEST in unsubscribed_topics
    assert GatewayMethods.SERVICE_ANNOUNCE in published_topics
    assert GatewayMethods.SERVICE_DEPART in published_topics
    service.stream.stop.assert_called_once_with()


@pytest.mark.asyncio
async def test_process_entrypoint_starts_and_stops_tts_service(monkeypatch) -> None:
    """starts and stops the TTS service through the process-mode entrypoint."""
    from app.services.tts import __main__ as tts_main

    events: list[str] = []
    bus = SimpleNamespace(start=AsyncMock(), stop=AsyncMock())
    service = SimpleNamespace(start=AsyncMock(), stop=AsyncMock())

    class ShutdownSignalWaiter:
        def __init__(self, service_name: str) -> None:
            events.append(f"install:{service_name}")

        async def wait(self) -> None:
            events.append("wait")

        def close(self) -> None:
            events.append("close")

    monkeypatch.setattr(tts_main, "register_all_service_topics", lambda: events.append("topics"))
    monkeypatch.setattr(
        tts_main,
        "initialize_bus_for_service",
        lambda service_name: events.append(service_name) or bus,
    )
    monkeypatch.setattr(tts_main, "TTSService", lambda: service)
    monkeypatch.setattr(tts_main, "ShutdownSignalWaiter", ShutdownSignalWaiter)

    await tts_main.main()

    assert events == ["install:TTSService", "topics", "TTSService", "wait", "close"]
    bus.start.assert_awaited_once_with()
    service.start.assert_awaited_once_with()
    service.stop.assert_awaited_once_with()
    bus.stop.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_process_entrypoint_stops_bus_when_tts_service_stop_fails(
    monkeypatch,
) -> None:
    """stops the process bus even when service cleanup raises."""
    from app.services.tts import __main__ as tts_main

    class ShutdownSignalWaiter:
        def __init__(self, _service_name: str) -> None:
            pass

        async def wait(self) -> None:
            pass

        def close(self) -> None:
            pass

    bus = SimpleNamespace(start=AsyncMock(), stop=AsyncMock())
    service = SimpleNamespace(
        start=AsyncMock(),
        stop=AsyncMock(side_effect=RuntimeError("stop failed")),
    )

    monkeypatch.setattr(tts_main, "register_all_service_topics", lambda: None)
    monkeypatch.setattr(tts_main, "initialize_bus_for_service", lambda _service_name: bus)
    monkeypatch.setattr(tts_main, "TTSService", lambda: service)
    monkeypatch.setattr(tts_main, "ShutdownSignalWaiter", ShutdownSignalWaiter)

    with pytest.raises(RuntimeError, match="stop failed"):
        await tts_main.main()

    service.stop.assert_awaited_once_with()
    bus.stop.assert_awaited_once_with()
