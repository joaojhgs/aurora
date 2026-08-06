"""PocketTTS TTS service wiring tests."""

from __future__ import annotations

import asyncio
import base64
import sys
import types
from unittest.mock import AsyncMock, Mock

import pytest

from app.services.tts.playback import PCMServerPlayback
from app.services.tts.providers.base import (
    TTSProviderCapabilities,
    TTSProviderError,
    TTSProviderHealth,
    TTSSynthesisResult,
    TTSVoiceInfo,
    VoiceSelectionMode,
)
from app.services.tts.service import TTSService
from app.shared.config.models import Piper, Pockettts, Providers, System, Tts
from app.shared.contracts.models.tts import (
    TTSAudioChunkEvent,
    TTSMethods,
    TTSRequest,
    TTSStreamChunkRequest,
    TTSStreamStartRequest,
)
from app.shared.messaging import bus_init


@pytest.fixture
def mock_bus():
    FakePocketProvider.instances = []
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

    def play_pcm_async(self, audio: bytes, *, sample_rate: int) -> None:
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
        self.__class__.instances.append(self)

    @property
    def capabilities(self) -> TTSProviderCapabilities:
        return TTSProviderCapabilities(
            provider_id="pockettts",
            voice_selection_mode=VoiceSelectionMode.SHARED_MODEL_STATE,
        )

    async def start(self) -> None:
        self.started = True

    async def stop(self) -> None:
        self.stopped = True

    async def health(self) -> TTSProviderHealth:
        return TTSProviderHealth("pockettts", True, "standard:alba", "pockettts:base")

    async def list_voices(self) -> tuple[TTSVoiceInfo, ...]:
        return (TTSVoiceInfo("standard:alba", "Alba", True, "german"),)

    async def synthesize(self, request) -> TTSSynthesisResult:
        self.requests.append(request)
        return TTSSynthesisResult(
            audio=b"\x01\x00\x02\x00",
            audio_format=request.audio_format,
            sample_rate=24000,
            channels=1,
            duration_ms=2 / 24000 * 1000,
            voice=request.voice or "standard:alba",
        )

    def stream(self, request):
        raise NotImplementedError

    async def cancel(self, request_id: str) -> None:
        self.cancelled.append(request_id)


class FakePiperProvider(FakePocketProvider):
    @property
    def capabilities(self) -> TTSProviderCapabilities:
        return TTSProviderCapabilities(
            provider_id="piper",
            voice_selection_mode=VoiceSelectionMode.ACTIVE_ONLY,
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
    assert provider.config.voices[0].voice_id == "standard:alba"


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
async def test_pockettts_request_playback_uses_single_synthesis_and_cancels_provider(
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
    assert provider.cancelled == ["request-1"]
    topics = [call.args[0] for call in mock_bus.publish.await_args_list]
    assert topics == [TTSMethods.STARTED, TTSMethods.STOPPED]


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
    assert [(event.sequence, event.is_final) for event in events] == [(0, False), (1, True)]
    assert base64.b64decode(events[0].audio_data) == b"\x01\x00\x02\x00"
    assert playback.played == [(b"\x01\x00\x02\x00", 24000)]
    assert [request.text for request in provider.requests] == ["first"]


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
async def test_pockettts_request_error_when_pcm_output_unavailable(mock_bus) -> None:
    service = TTSService()
    service._provider = FakePocketProvider(None)

    class UnavailablePCM(FakePCMPlayback):
        def play_pcm_async(self, audio: bytes, *, sample_rate: int) -> None:
            raise RuntimeError("TTS audio output unavailable")

    service.stream = UnavailablePCM()

    await service._on_tts_request(TTSRequest(text="hello"))

    topics = [call.args[0] for call in mock_bus.publish.await_args_list]
    assert TTSMethods.STARTED not in topics
    assert TTSMethods.STOPPED not in topics
    assert topics == [TTSMethods.ERROR]
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
