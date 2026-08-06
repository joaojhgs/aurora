"""PocketTTS TTS service wiring tests."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import os
import sys
import tempfile
import types
from unittest.mock import AsyncMock, Mock

import pytest

from app.services.tts.playback import PCMServerPlayback
from app.services.tts.providers.base import (
    TTSProviderCapabilities,
    TTSProviderError,
    TTSProviderHealth,
    TTSStreamChunk,
    TTSSynthesisResult,
    TTSVoiceInfo,
    VoiceSelectionMode,
)
from app.services.tts.service import TTSService
from app.services.tts.voice_registry import VoiceCatalogEntry, VoiceStateArtifactHandle
from app.shared.config.models import (
    Piper,
    Pockettts,
    Providers,
    System,
    Tts,
    VoiceRegistry as VoiceRegistryConfig,
)
from app.shared.contracts.models.tts import (
    TTSAudioChunkEvent,
    TTSMethods,
    TTSRequest,
    TTSStopRequest,
    TTSStreamChunkRequest,
    TTSStreamEndRequest,
    TTSStreamStartRequest,
)
from app.shared.messaging import bus_init


@pytest.fixture
def mock_bus():
    FakePocketProvider.instances = []
    FakeVoiceRegistry.entries = ()
    FakeVoiceRegistry.resolved = []
    FakeVoiceRegistry.opened_fds = []
    FakeVoiceRegistry.fail_resolve_for = None
    FakeVoiceRegistry.cancel_resolve_for = None
    bus = Mock()
    bus.publish = AsyncMock()
    bus.subscribe = Mock()
    bus.unsubscribe = Mock()
    bus_init.set_bus(bus)
    yield bus
    bus_init._bus = None
    bus_init._service_buses.clear()


class FakePCMPlayback:
    supports_text_feed = False
    supports_pcm = True

    def __init__(self) -> None:
        self.played: list[tuple[bytes, int]] = []
        self.stopped = 0
        self.paused = 0
        self.resumed = 0

    def play_pcm_async(
        self, audio: bytes, *, sample_rate: int, playback_id: int | None = None
    ) -> None:
        del playback_id
        self.played.append((audio, sample_rate))

    def stop(self) -> None:
        self.stopped += 1

    def pause(self) -> None:
        self.paused += 1

    def resume(self) -> None:
        self.resumed += 1


class FakeTextPlayback:
    supports_text_feed = True
    supports_pcm = False

    def __init__(self) -> None:
        self.feed = Mock()
        self.play_async = Mock()
        self.stop = Mock()
        self.pause = Mock()
        self.resume = Mock()


class FakePocketProvider:
    instances: list[FakePocketProvider] = []

    def __init__(self, config) -> None:
        self.config = config
        self.started = False
        self.stopped = False
        self.cancelled: list[str] = []
        self.requests = []
        self.stream_requests = []
        self.synthesize_started = asyncio.Event()
        self.release_synthesis = asyncio.Event()
        self.block_synthesis = False
        self.stream_started = asyncio.Event()
        self.release_stream = asyncio.Event()
        self.block_stream_after_first = False
        self.__class__.instances.append(self)

    @property
    def capabilities(self) -> TTSProviderCapabilities:
        return TTSProviderCapabilities(
            provider_id="pockettts",
            voice_selection_mode=VoiceSelectionMode.SHARED_MODEL_STATE,
        )

    async def start(self) -> None:
        self.started = True
        for voice in getattr(self.config, "voices", ()):
            with contextlib.suppress(OSError):
                os.close(voice.artifact_handle.fd)

    async def stop(self) -> None:
        self.stopped = True

    async def health(self) -> TTSProviderHealth:
        return TTSProviderHealth("pockettts", True, "standard:starter_en:alba", "pockettts:base")

    async def list_voices(self) -> tuple[TTSVoiceInfo, ...]:
        return (TTSVoiceInfo("standard:starter_en:alba", "Alba", True, "german"),)

    async def synthesize(self, request) -> TTSSynthesisResult:
        self.requests.append(request)
        self.synthesize_started.set()
        if self.block_synthesis:
            while request.request_id not in self.cancelled and not self.release_synthesis.is_set():
                await asyncio.sleep(0.01)
            if request.request_id in self.cancelled:
                raise TTSProviderError("cancelled", "TTS request was cancelled")
        return TTSSynthesisResult(
            audio=b"\x01\x00\x02\x00",
            audio_format=request.audio_format,
            sample_rate=24000,
            channels=1,
            duration_ms=2 / 24000 * 1000,
            voice=request.voice or "standard:starter_en:alba",
        )

    async def stream(self, request):
        self.stream_requests.append(request)
        self.stream_started.set()
        yield TTSStreamChunk(
            sequence=0,
            audio=b"\x03\x00",
            sample_rate=24000,
            channels=1,
            duration_ms=1 / 24000 * 1000,
        )
        if self.block_stream_after_first:
            while request.request_id not in self.cancelled and not self.release_stream.is_set():
                await asyncio.sleep(0.01)
            if request.request_id in self.cancelled:
                raise TTSProviderError("cancelled", "TTS request was cancelled")
        yield TTSStreamChunk(
            sequence=1,
            audio=b"\x04\x00",
            sample_rate=24000,
            channels=1,
            duration_ms=1 / 24000 * 1000,
        )
        yield TTSStreamChunk(
            sequence=2,
            audio=b"",
            sample_rate=24000,
            channels=1,
            is_final=True,
        )

    async def cancel(self, request_id: str) -> None:
        self.cancelled.append(request_id)


class FailingStartPocketProvider(FakePocketProvider):
    async def start(self) -> None:
        await super().start()
        raise TTSProviderError("unavailable", "PocketTTS is unavailable")


class FakePiperProvider(FakePocketProvider):
    @property
    def capabilities(self) -> TTSProviderCapabilities:
        return TTSProviderCapabilities(
            provider_id="piper",
            voice_selection_mode=VoiceSelectionMode.ACTIVE_ONLY,
        )


def _registry_handle(voice_id: str, identity) -> VoiceStateArtifactHandle:
    payload = f"registry-state:{voice_id}".encode()
    with tempfile.TemporaryFile() as file:
        file.write(payload)
        file.flush()
        file.seek(0)
        fd = os.dup(file.fileno())
    return VoiceStateArtifactHandle(
        voice_id=voice_id,
        runtime_target=identity.runtime_target,
        language_bundle=identity.language_bundle,
        compatibility_group=identity.compatibility_group,
        artifact_revision="rev1",
        relative_ref="artifacts/profile/voice-state.safetensors",
        sha256=hashlib.sha256(payload).hexdigest(),
        size_bytes=len(payload),
        format="safetensors",
        fd=fd,
    )


class FakeVoiceRegistry:
    entries: tuple[VoiceCatalogEntry, ...] = ()
    resolved: list[str] = []
    opened_fds: list[int] = []
    fail_resolve_for: str | None = None
    cancel_resolve_for: str | None = None

    def __init__(self, root) -> None:
        self.root = root

    async def catalog(self, identity, *, include_private: bool = False):
        del identity, include_private
        return self.entries

    async def resolve_voice_state_artifact(self, voice_id: str, identity):
        if voice_id == self.cancel_resolve_for:
            raise asyncio.CancelledError()
        if voice_id == self.fail_resolve_for:
            raise RuntimeError("registry storage unavailable")
        self.resolved.append(voice_id)
        handle = _registry_handle(voice_id, identity)
        self.opened_fds.append(handle.fd)
        return handle


def _catalog_entry(
    voice_id: str,
    *,
    display_name: str = "Voice",
    kind: str = "standard",
    ready: bool = True,
    language_bundle: str = "english_2026-04",
) -> VoiceCatalogEntry:
    return VoiceCatalogEntry(
        voice_id=voice_id,
        display_name=display_name,
        kind=kind,
        ready=ready,
        language_bundle=language_bundle,
        runtime_target="pockettts-python",
    )


async def _fake_config_for(tts_cfg: Tts, system_cfg: System):
    async def fake_config(key, model=None, *args, **kwargs):
        del model, args, kwargs
        if str(key) == "services.tts":
            return tts_cfg
        if str(key) == "system":
            return system_cfg
        raise AssertionError(f"unexpected config key: {key}")

    return fake_config


def _audio_events(mock_bus) -> list[TTSAudioChunkEvent]:
    return [
        call.args[1]
        for call in mock_bus.publish.await_args_list
        if call.args[0] == TTSMethods.AUDIO_CHUNK
    ]


def _fd_is_closed(fd: int) -> bool:
    try:
        os.fstat(fd)
    except OSError:
        return True
    return False


@pytest.mark.asyncio
async def test_pockettts_runtime_uses_system_language_quality_and_no_realtimetts(
    monkeypatch, mock_bus
) -> None:
    playback = FakePCMPlayback()
    tts_cfg = Tts(
        provider="pockettts",
        providers=Providers(pockettts=Pockettts(quality_tier="quality")),
    )
    fake_config = await _fake_config_for(
        tts_cfg,
        System(primary_language="en", voice_language="de"),
    )

    monkeypatch.setattr("app.services.tts.service.config_api.aget", fake_config)
    monkeypatch.setattr("app.services.tts.service.PocketTTSProvider", FakePocketProvider)
    FakeVoiceRegistry.entries = (
        VoiceCatalogEntry(
            voice_id="standard:starter_de:anna",
            display_name="Anna",
            kind="standard",
            ready=True,
            language_bundle="german_24l",
            runtime_target="pockettts-python",
        ),
    )
    FakeVoiceRegistry.resolved = []
    monkeypatch.setattr("app.services.tts.service.VoiceRegistry", FakeVoiceRegistry)
    monkeypatch.setattr("app.services.tts.service.create_pcm_playback", lambda **_kwargs: playback)
    monkeypatch.setattr(
        "app.services.tts.service.create_realtime_piper_stream",
        Mock(side_effect=AssertionError("RealtimeTTS path must not be constructed")),
    )

    service = TTSService()
    provider, engine, stream = await service._build_runtime()

    assert provider is FakePocketProvider.instances[-1]
    assert engine is None
    assert stream is playback
    assert provider.config.effective_language == "de"
    assert provider.config.quality_tier == "quality"
    assert provider.config.voices[0].voice_id == "standard:starter_de:anna"
    assert FakeVoiceRegistry.resolved == ["standard:starter_de:anna"]


@pytest.mark.asyncio
async def test_pockettts_custom_config_fails_closed_before_provider_construction(
    monkeypatch, mock_bus
) -> None:
    tts_cfg = Tts(
        provider="pockettts",
        providers=Providers(
            pockettts=Pockettts(custom_config_path="voice_models/custom-pockettts.json")
        ),
    )
    fake_config = await _fake_config_for(tts_cfg, System(primary_language="es"))

    monkeypatch.setattr("app.services.tts.service.config_api.aget", fake_config)
    monkeypatch.setattr("app.services.tts.service.PocketTTSProvider", FakePocketProvider)

    with pytest.raises(TTSProviderError) as exc_info:
        await TTSService()._build_runtime()

    assert exc_info.value.code == "unsupported_voice"
    assert FakePocketProvider.instances == []


@pytest.mark.asyncio
async def test_pockettts_empty_registry_fails_before_provider_construction(
    monkeypatch, mock_bus
) -> None:
    tts_cfg = Tts(
        provider="pockettts",
        providers=Providers(pockettts=Pockettts()),
    )
    fake_config = await _fake_config_for(tts_cfg, System(primary_language="en"))

    monkeypatch.setattr("app.services.tts.service.config_api.aget", fake_config)
    monkeypatch.setattr("app.services.tts.service.PocketTTSProvider", FakePocketProvider)
    monkeypatch.setattr("app.services.tts.service.VoiceRegistry", FakeVoiceRegistry)

    with pytest.raises(TTSProviderError) as exc_info:
        await TTSService()._build_runtime()

    assert exc_info.value.code == "unsupported_voice"
    assert FakePocketProvider.instances == []
    assert FakeVoiceRegistry.resolved == []


@pytest.mark.asyncio
async def test_pockettts_resolves_explicit_standard_and_clone_ids_in_order(
    monkeypatch, mock_bus
) -> None:
    clone_id = "clone:00000000-0000-4000-8000-000000000001"
    tts_cfg = Tts(
        provider="pockettts",
        default_voice_id="standard:starter_en:alba",
        providers=Providers(
            pockettts=Pockettts(
                preload_voice_ids=[clone_id, "standard:starter_en:alba"],
            )
        ),
    )
    fake_config = await _fake_config_for(tts_cfg, System(primary_language="en"))

    monkeypatch.setattr("app.services.tts.service.config_api.aget", fake_config)
    monkeypatch.setattr("app.services.tts.service.PocketTTSProvider", FakePocketProvider)
    monkeypatch.setattr("app.services.tts.service.VoiceRegistry", FakeVoiceRegistry)
    monkeypatch.setattr("app.services.tts.service.create_pcm_playback", lambda **_kwargs: object())
    FakeVoiceRegistry.entries = (
        _catalog_entry("standard:starter_en:alba", display_name="Alba"),
        _catalog_entry(clone_id, display_name="Local", kind="clone"),
    )

    provider, _engine, _stream = await TTSService()._build_runtime()

    assert [voice.voice_id for voice in provider.config.voices] == [
        "standard:starter_en:alba",
        clone_id,
    ]
    assert FakeVoiceRegistry.resolved == ["standard:starter_en:alba", clone_id]


@pytest.mark.asyncio
async def test_pockettts_partial_resolution_failure_closes_opened_registry_handles(
    monkeypatch, mock_bus
) -> None:
    clone_id = "clone:00000000-0000-4000-8000-000000000001"
    tts_cfg = Tts(
        provider="pockettts",
        default_voice_id="standard:starter_en:alba",
        providers=Providers(pockettts=Pockettts(preload_voice_ids=[clone_id])),
    )
    fake_config = await _fake_config_for(tts_cfg, System(primary_language="en"))

    monkeypatch.setattr("app.services.tts.service.config_api.aget", fake_config)
    monkeypatch.setattr("app.services.tts.service.PocketTTSProvider", FakePocketProvider)
    monkeypatch.setattr("app.services.tts.service.VoiceRegistry", FakeVoiceRegistry)
    FakeVoiceRegistry.entries = (
        _catalog_entry("standard:starter_en:alba", display_name="Alba"),
        _catalog_entry(clone_id, display_name="Local", kind="clone"),
    )
    FakeVoiceRegistry.fail_resolve_for = clone_id

    with pytest.raises(TTSProviderError) as exc_info:
        await TTSService()._build_runtime()

    assert exc_info.value.code == "unsupported_voice"
    assert FakePocketProvider.instances == []
    assert len(FakeVoiceRegistry.opened_fds) == 1
    assert _fd_is_closed(FakeVoiceRegistry.opened_fds[0])


@pytest.mark.asyncio
async def test_pockettts_partial_resolution_cancellation_closes_opened_registry_handles(
    monkeypatch, mock_bus
) -> None:
    clone_id = "clone:00000000-0000-4000-8000-000000000001"
    tts_cfg = Tts(
        provider="pockettts",
        default_voice_id="standard:starter_en:alba",
        providers=Providers(pockettts=Pockettts(preload_voice_ids=[clone_id])),
    )
    fake_config = await _fake_config_for(tts_cfg, System(primary_language="en"))

    monkeypatch.setattr("app.services.tts.service.config_api.aget", fake_config)
    monkeypatch.setattr("app.services.tts.service.PocketTTSProvider", FakePocketProvider)
    monkeypatch.setattr("app.services.tts.service.VoiceRegistry", FakeVoiceRegistry)
    FakeVoiceRegistry.entries = (
        _catalog_entry("standard:starter_en:alba", display_name="Alba"),
        _catalog_entry(clone_id, display_name="Local", kind="clone"),
    )
    FakeVoiceRegistry.cancel_resolve_for = clone_id

    with pytest.raises(asyncio.CancelledError):
        await TTSService()._build_runtime()

    assert FakePocketProvider.instances == []
    assert len(FakeVoiceRegistry.opened_fds) == 1
    assert _fd_is_closed(FakeVoiceRegistry.opened_fds[0])


@pytest.mark.parametrize(
    ("voice_id", "kind", "registry_config"),
    [
        (
            "standard:starter_en:alba",
            "standard",
            VoiceRegistryConfig(standard_pack_enabled=False),
        ),
        (
            "clone:00000000-0000-4000-8000-000000000001",
            "clone",
            VoiceRegistryConfig(cloning_enabled=False),
        ),
    ],
)
@pytest.mark.asyncio
async def test_pockettts_disabled_registry_kind_fails_closed_before_provider_construction(
    voice_id: str,
    kind: str,
    registry_config: VoiceRegistryConfig,
    monkeypatch,
    mock_bus,
) -> None:
    tts_cfg = Tts(
        provider="pockettts",
        default_voice_id=voice_id,
        voice_registry=registry_config,
        providers=Providers(pockettts=Pockettts()),
    )
    fake_config = await _fake_config_for(tts_cfg, System(primary_language="en"))

    monkeypatch.setattr("app.services.tts.service.config_api.aget", fake_config)
    monkeypatch.setattr("app.services.tts.service.PocketTTSProvider", FakePocketProvider)
    monkeypatch.setattr("app.services.tts.service.VoiceRegistry", FakeVoiceRegistry)
    FakeVoiceRegistry.entries = (_catalog_entry(voice_id, kind=kind),)

    with pytest.raises(TTSProviderError) as exc_info:
        await TTSService()._build_runtime()

    assert exc_info.value.code == "unsupported_voice"
    assert FakePocketProvider.instances == []
    assert FakeVoiceRegistry.resolved == []


@pytest.mark.asyncio
async def test_pockettts_runtime_start_failure_stops_constructed_provider(
    monkeypatch, mock_bus
) -> None:
    tts_cfg = Tts(
        provider="pockettts",
        providers=Providers(pockettts=Pockettts()),
    )
    fake_config = await _fake_config_for(tts_cfg, System(primary_language="en"))

    monkeypatch.setattr("app.services.tts.service.config_api.aget", fake_config)
    monkeypatch.setattr("app.services.tts.service.PocketTTSProvider", FailingStartPocketProvider)
    monkeypatch.setattr("app.services.tts.service.VoiceRegistry", FakeVoiceRegistry)
    FakeVoiceRegistry.entries = (_catalog_entry("standard:starter_en:alba"),)

    with pytest.raises(TTSProviderError) as exc_info:
        await TTSService()._build_runtime()

    assert exc_info.value.code == "unavailable"
    assert len(FailingStartPocketProvider.instances) == 1
    assert FailingStartPocketProvider.instances[0].stopped is True


@pytest.mark.asyncio
async def test_pockettts_playback_construction_failure_stops_started_provider(
    monkeypatch, mock_bus
) -> None:
    tts_cfg = Tts(
        provider="pockettts",
        providers=Providers(pockettts=Pockettts()),
    )
    fake_config = await _fake_config_for(tts_cfg, System(primary_language="en"))

    monkeypatch.setattr("app.services.tts.service.config_api.aget", fake_config)
    monkeypatch.setattr("app.services.tts.service.PocketTTSProvider", FakePocketProvider)
    monkeypatch.setattr("app.services.tts.service.VoiceRegistry", FakeVoiceRegistry)
    monkeypatch.setattr(
        "app.services.tts.service.create_pcm_playback",
        Mock(side_effect=RuntimeError("audio output unavailable")),
    )
    FakeVoiceRegistry.entries = (_catalog_entry("standard:starter_en:alba"),)

    with pytest.raises(RuntimeError, match="audio output unavailable"):
        await TTSService()._build_runtime()

    assert len(FakePocketProvider.instances) == 1
    assert FakePocketProvider.instances[0].started is True
    assert FakePocketProvider.instances[0].stopped is True


@pytest.mark.asyncio
async def test_piper_remains_default_and_uses_text_playback(monkeypatch, mock_bus) -> None:
    playback = FakeTextPlayback()
    tts_cfg = Tts(
        providers=Providers(piper=Piper(model_file_path="voice.onnx", executable_path="piper"))
    )
    fake_config = await _fake_config_for(tts_cfg, System())

    monkeypatch.setattr("app.services.tts.service.config_api.aget", fake_config)
    monkeypatch.setattr(
        "app.services.tts.service.PiperTTSProvider", lambda **_kwargs: FakePiperProvider(None)
    )
    monkeypatch.setattr(
        "app.services.tts.service.create_realtime_piper_stream",
        lambda **_kwargs: (object(), playback),
    )
    monkeypatch.setattr("app.services.tts.service.resolve_path", lambda path: path)

    provider, engine, stream = await TTSService()._build_runtime()

    assert provider.capabilities.provider_id == "piper"
    assert engine is not None
    assert stream is playback


@pytest.mark.asyncio
async def test_pockettts_request_playback_uses_single_synthesis_and_stops_playback(
    mock_bus,
) -> None:
    service = TTSService()
    provider = FakePocketProvider(None)
    playback = FakePCMPlayback()
    service._provider = provider
    service.stream = playback

    await service._play_text("hello", "request-1")
    await service._stop_playback("interrupted")

    assert [request.text for request in provider.requests] == ["hello"]
    assert playback.played == [(b"\x01\x00\x02\x00", 24000)]
    assert provider.cancelled == []
    topics = [call.args[0] for call in mock_bus.publish.await_args_list]
    assert topics == [TTSMethods.STARTED, TTSMethods.STOPPED]


@pytest.mark.asyncio
async def test_pockettts_stop_during_synthesis_cancels_and_suppresses_late_events(
    mock_bus,
) -> None:
    service = TTSService()
    provider = FakePocketProvider(None)
    provider.block_synthesis = True
    playback = FakePCMPlayback()
    service._provider = provider
    service.stream = playback

    request_task = asyncio.create_task(service._on_tts_request(TTSRequest(text="pending")))
    await asyncio.wait_for(provider.synthesize_started.wait(), timeout=1)

    await service._on_stop(TTSStopRequest(reason="interrupted"))
    await asyncio.wait_for(request_task, timeout=1)

    assert provider.cancelled
    assert playback.played == []
    assert mock_bus.publish.await_args_list == []
    assert service._playing is False


@pytest.mark.asyncio
async def test_pockettts_stream_events_and_server_playback_reuse_synthesized_pcm(
    mock_bus,
) -> None:
    service = TTSService()
    provider = FakePocketProvider(None)
    playback = FakePCMPlayback()
    service._provider = provider
    service.stream = playback

    await service._on_stream_start(
        TTSStreamStartRequest(stream_id="stream-1", format="raw", play_on_server=True)
    )
    await service._on_stream_chunk(
        TTSStreamChunkRequest(stream_id="stream-1", sequence=0, text="first", is_final=True)
    )

    events = _audio_events(mock_bus)
    assert [(event.sequence, event.is_final) for event in events] == [
        (0, False),
        (1, False),
        (2, True),
    ]
    assert [base64.b64decode(event.audio_data) for event in events[:-1]] == [
        b"\x03\x00",
        b"\x04\x00",
    ]
    assert playback.played == [(b"\x03\x00", 24000), (b"\x04\x00", 24000)]
    assert provider.requests == []
    assert [request.text for request in provider.stream_requests] == ["first"]


@pytest.mark.asyncio
async def test_pockettts_stream_clear_cancels_active_provider_stream(mock_bus) -> None:
    service = TTSService()
    provider = FakePocketProvider(None)
    provider.block_stream_after_first = True
    playback = FakePCMPlayback()
    service._provider = provider
    service.stream = playback

    await service._on_stream_start(
        TTSStreamStartRequest(stream_id="stream-cancel", format="raw", play_on_server=True)
    )
    chunk_task = asyncio.create_task(
        service._on_stream_chunk(
            TTSStreamChunkRequest(stream_id="stream-cancel", sequence=0, text="first")
        )
    )
    await asyncio.wait_for(provider.stream_started.wait(), timeout=1)
    while not _audio_events(mock_bus):
        await asyncio.sleep(0.01)

    await service._on_stop(TTSStopRequest(reason="interrupted"))
    await asyncio.wait_for(chunk_task, timeout=1)

    assert provider.cancelled == ["stream-cancel:0"]
    topics = [call.args[0] for call in mock_bus.publish.await_args_list]
    assert topics == [
        TTSMethods.AUDIO_CHUNK,
        TTSMethods.STARTED,
        TTSMethods.STOPPED,
        TTSMethods.AUDIO_CHUNK,
    ]
    terminal_events = [event for event in _audio_events(mock_bus) if event.is_final]
    assert len(terminal_events) == 1
    assert terminal_events[0].stream_id == "stream-cancel"
    assert terminal_events[0].reason == "interrupted"


@pytest.mark.asyncio
async def test_pockettts_reload_failure_keeps_old_provider_and_playback(
    mock_bus, monkeypatch
) -> None:
    service = TTSService()
    old_provider = FakePocketProvider(None)
    old_playback = FakePCMPlayback()
    service._provider = old_provider
    service.stream = old_playback
    service.engine = None
    service._playing = True
    service._current_request_id = "active"

    async def fail_build_runtime():
        raise TTSProviderError("unsupported_voice", "PocketTTS custom config is unavailable")

    monkeypatch.setattr(service, "_build_runtime", fail_build_runtime)

    await service.reload("services.tts")

    assert service._provider is old_provider
    assert service.stream is old_playback
    assert old_provider.stopped is False
    assert old_playback.stopped == 0
    assert service._playing is True
    assert service._current_request_id == "active"


@pytest.mark.asyncio
async def test_pockettts_successful_reload_closes_old_playback_when_idle(
    mock_bus, monkeypatch
) -> None:
    service = TTSService()
    old_provider = FakePocketProvider(None)
    new_provider = FakePocketProvider(None)
    old_playback = FakePCMPlayback()
    new_playback = FakePCMPlayback()
    service._provider = old_provider
    service.stream = old_playback
    service.engine = object()

    async def build_runtime():
        return new_provider, None, new_playback

    monkeypatch.setattr(service, "_build_runtime", build_runtime)

    await service.reload("services.tts")

    assert service._provider is new_provider
    assert service.stream is new_playback
    assert old_provider.stopped is True
    assert old_playback.stopped == 1


@pytest.mark.asyncio
async def test_pockettts_request_error_when_pcm_output_unavailable(mock_bus) -> None:
    service = TTSService()
    service._provider = FakePocketProvider(None)

    class UnavailablePCM(FakePCMPlayback):
        def play_pcm_async(
            self, audio: bytes, *, sample_rate: int, playback_id: int | None = None
        ) -> None:
            del playback_id
            raise RuntimeError("TTS audio output unavailable")

    service.stream = UnavailablePCM()

    await service._on_tts_request(TTSRequest(text="hello"))

    topics = [call.args[0] for call in mock_bus.publish.await_args_list]
    assert topics == [TTSMethods.STARTED, TTSMethods.ERROR, TTSMethods.STOPPED]
    assert mock_bus.publish.await_args_list[-1].args[1].reason == "failed"
    assert service._playing is False


def _install_fake_pyaudio(
    monkeypatch, writes: list[bytes], wrote: asyncio.Event | None = None
) -> None:
    module = types.ModuleType("pyaudio")
    module.paInt16 = object()
    loop = asyncio.get_running_loop() if wrote is not None else None

    class FakeOutput:
        def write(self, data: bytes) -> None:
            writes.append(data)
            if wrote is not None and loop is not None:
                loop.call_soon_threadsafe(wrote.set)

        def stop_stream(self) -> None:
            pass

        def close(self) -> None:
            pass

    class FakePyAudio:
        def open(self, **_kwargs):
            return FakeOutput()

        def terminate(self) -> None:
            pass

    module.PyAudio = FakePyAudio
    monkeypatch.setitem(sys.modules, "pyaudio", module)


@pytest.mark.asyncio
async def test_pcm_playback_stop_then_replay_does_not_consume_stale_stop(monkeypatch) -> None:
    writes: list[bytes] = []
    _install_fake_pyaudio(monkeypatch, writes)
    starts: list[str] = []
    stops: list[str] = []
    playback = PCMServerPlayback(
        on_audio_stream_start=lambda: starts.append("start"),
        on_audio_stream_stop=lambda: stops.append("stop"),
        frames_per_buffer=1,
    )

    playback.play_pcm_async(b"\x01\x00", sample_rate=24000)
    await asyncio.sleep(0.05)
    playback.stop()
    playback.play_pcm_async(b"\x02\x00", sample_rate=24000)

    deadline = asyncio.get_running_loop().time() + 1
    while b"\x02\x00" not in writes:
        if asyncio.get_running_loop().time() > deadline:
            pytest.fail("replayed PCM was not written")
        await asyncio.sleep(0.01)
    playback.stop()

    assert b"\x01\x00" in writes
    assert b"\x02\x00" in writes
    assert len(starts) == len(stops)


@pytest.mark.asyncio
async def test_pcm_playback_enqueue_near_worker_exit_is_not_stranded(monkeypatch) -> None:
    writes: list[bytes] = []
    first_written = asyncio.Event()
    _install_fake_pyaudio(monkeypatch, writes, first_written)
    playback = PCMServerPlayback(
        on_audio_stream_start=lambda: None,
        on_audio_stream_stop=lambda: None,
        frames_per_buffer=1,
    )

    playback.play_pcm_async(b"\x01\x00", sample_rate=24000)
    await asyncio.wait_for(first_written.wait(), timeout=1)
    playback.play_pcm_async(b"\x02\x00", sample_rate=24000)

    deadline = asyncio.get_running_loop().time() + 1
    while b"\x02\x00" not in writes:
        if asyncio.get_running_loop().time() > deadline:
            pytest.fail("queued PCM was stranded at worker exit")
        await asyncio.sleep(0.01)
    playback.stop()


def test_pcm_playback_unavailable_output_raises_without_lifecycle_callbacks(monkeypatch) -> None:
    monkeypatch.delitem(sys.modules, "pyaudio", raising=False)
    monkeypatch.setattr(
        "app.services.tts.playback.importlib.import_module",
        Mock(side_effect=ImportError("missing pyaudio")),
    )
    starts: list[str] = []
    stops: list[str] = []
    playback = PCMServerPlayback(
        on_audio_stream_start=lambda: starts.append("start"),
        on_audio_stream_stop=lambda: stops.append("stop"),
    )

    with pytest.raises(RuntimeError, match="audio output unavailable"):
        playback.play_pcm_async(b"\x01\x00", sample_rate=24000)

    assert starts == []
    assert stops == []
