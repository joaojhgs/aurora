"""PocketTTS TTS service wiring tests."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import io
import json
import os
import sys
import tempfile
import types
import wave
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, Mock

import pytest

from app.messaging import Envelope
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
from app.shared.contracts.models.auth import AuthMethods
from app.shared.contracts.models.tts import (
    TTSAudioChunkEvent,
    TTSCreateVoiceProfileRequest,
    TTSDeleteVoiceProfileRequest,
    TTSGetCapabilitiesRequest,
    TTSInstallVoiceProfileRequest,
    TTSListVoiceProfilesRequest,
    TTSListVoicesRequest,
    TTSMethods,
    TTSRequest,
    TTSStopRequest,
    TTSStreamChunkRequest,
    TTSStreamEndRequest,
    TTSStreamStartRequest,
    TTSVoiceImportAbortRequest,
    TTSVoiceImportChunkRequest,
    TTSVoiceImportEndRequest,
    TTSVoiceImportStartRequest,
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
    FakeVoiceRegistry.installed = []
    FakeVoiceRegistry.deleted = []
    FakeVoiceRegistry.install_calls = 0
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


class FakeVoiceListingProvider(FakePocketProvider):
    def __init__(self, voices, *, active_voice: str | None = None) -> None:
        super().__init__(None)
        self._voices = tuple(voices)
        self._active_voice = active_voice

    async def health(self) -> TTSProviderHealth:
        return TTSProviderHealth("pockettts", True, self._active_voice, "pockettts:base")

    async def list_voices(self) -> tuple[TTSVoiceInfo, ...]:
        return self._voices


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
    installed = []
    deleted: list[str] = []
    install_calls = 0

    def __init__(self, root) -> None:
        self.root = root

    async def catalog(self, identity, *, include_private: bool = False):
        del identity, include_private
        return self.entries

    async def inventory(self):
        return self.installed

    async def install_standard_pack(self, manifest_path, artifact_root):
        del manifest_path, artifact_root
        self.__class__.install_calls += 1
        return tuple(self.installed)

    async def delete_voice(self, voice_id: str):
        self.deleted.append(voice_id)

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


def _wav_payload(*, sample_rate: int = 16000, channels: int = 1, frames: int = 1600) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(channels)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(b"\0\0" * channels * frames)
    return buffer.getvalue()


async def _sealed_voice_upload(service: TTSService, envelope: Envelope):
    payload = _wav_payload()
    digest = hashlib.sha256(payload).hexdigest()
    started = await service.voice_import_start(
        TTSVoiceImportStartRequest(
            operation_id=f"start-{len(service._voice_import_sessions)}",
            expected_total_bytes=len(payload),
            sha256=digest,
            format="wav",
            sample_rate=16000,
        ),
        envelope,
    )
    await service.voice_import_chunk(
        TTSVoiceImportChunkRequest(
            operation_id=f"chunk-{started.upload_id}",
            upload_id=started.upload_id,
            sequence=0,
            chunk_data=base64.b64encode(payload).decode(),
            chunk_sha256=digest,
        ),
        envelope,
    )
    sealed = await service.voice_import_end(
        TTSVoiceImportEndRequest(
            operation_id=f"end-{started.upload_id}",
            upload_id=started.upload_id,
            final_sequence=0,
            final_sha256=digest,
        ),
        envelope,
    )
    return started, sealed


async def _start_voice_upload(
    service: TTSService,
    envelope: Envelope,
    payload: bytes,
    *,
    operation_id: str,
    expected_total_bytes: int | None = None,
    sha256: str | None = None,
    audio_format: str = "wav",
    sample_rate: int = 16000,
    channels: int = 1,
    sample_width_bytes: int = 2,
    duration_ms: int | None = None,
):
    return await service.voice_import_start(
        TTSVoiceImportStartRequest(
            operation_id=operation_id,
            expected_total_bytes=expected_total_bytes or len(payload),
            sha256=sha256 or hashlib.sha256(payload).hexdigest(),
            format=audio_format,
            sample_rate=sample_rate,
            channels=channels,
            sample_width_bytes=sample_width_bytes,
            duration_ms=duration_ms,
        ),
        envelope,
    )


async def _append_voice_chunk(
    service: TTSService,
    envelope: Envelope,
    upload_id: str,
    payload: bytes,
    *,
    operation_id: str,
    sequence: int = 0,
):
    return await service.voice_import_chunk(
        TTSVoiceImportChunkRequest(
            operation_id=operation_id,
            upload_id=upload_id,
            sequence=sequence,
            chunk_data=base64.b64encode(payload).decode(),
            chunk_sha256=hashlib.sha256(payload).hexdigest(),
        ),
        envelope,
    )


def _assert_redacted_rejection_audit(mock_bus, *, method: str, forbidden: list[str]) -> None:
    audit_call = mock_bus.request.await_args_list[-1]
    assert audit_call.args[0] == AuthMethods.STORE_AUDIT_EVENT
    details = audit_call.args[1].details
    assert details is not None
    parsed = json.loads(details)
    assert parsed["method"] == method
    assert parsed["phase"] == "outcome"
    assert parsed["status"] == "rejected"
    assert parsed["secrets_redacted"] is True
    assert "chunk_data" not in details
    for value in forbidden:
        assert value not in details


def _last_audit_details(mock_bus) -> dict[str, object]:
    audit_call = mock_bus.request.await_args_list[-1]
    assert audit_call.args[0] == AuthMethods.STORE_AUDIT_EVENT
    details = audit_call.args[1].details
    assert details is not None
    return json.loads(details)


def _assert_intent_attempt_audit(mock_bus, *, method: str) -> None:
    details = _last_audit_details(mock_bus)
    assert details["method"] == method
    assert details["phase"] == "intent"
    assert details["status"] == "attempted"


def _assert_outcome_audit(mock_bus, *, method: str, status: str) -> None:
    details = _last_audit_details(mock_bus)
    assert details["method"] == method
    assert details["phase"] == "outcome"
    assert details["status"] == status


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


def test_tts_voice_registration_contract_metadata() -> None:
    expected_use = {
        TTSMethods.GET_CAPABILITIES,
        TTSMethods.LIST_VOICES,
    }
    expected_manage = {
        TTSMethods.LIST_VOICE_PROFILES,
        TTSMethods.GET_VOICE_PROFILE,
        TTSMethods.UPDATE_VOICE_PROFILE,
        TTSMethods.INSTALL_VOICE_PROFILE,
        TTSMethods.REMOVE_VOICE_PROFILE,
        TTSMethods.SET_DEFAULT_VOICE,
        TTSMethods.VOICE_IMPORT_START,
        TTSMethods.VOICE_IMPORT_CHUNK,
        TTSMethods.VOICE_IMPORT_END,
        TTSMethods.VOICE_IMPORT_ABORT,
        TTSMethods.CREATE_VOICE_PROFILE,
        TTSMethods.DELETE_VOICE_PROFILE,
    }

    for method_id in expected_use | expected_manage:
        method_name = {
            TTSMethods.GET_CAPABILITIES: "get_capabilities",
            TTSMethods.LIST_VOICES: "list_voices",
            TTSMethods.LIST_VOICE_PROFILES: "list_voice_profiles",
            TTSMethods.GET_VOICE_PROFILE: "get_voice_profile",
            TTSMethods.UPDATE_VOICE_PROFILE: "update_voice_profile",
            TTSMethods.INSTALL_VOICE_PROFILE: "install_voice_profile",
            TTSMethods.REMOVE_VOICE_PROFILE: "remove_voice_profile",
            TTSMethods.SET_DEFAULT_VOICE: "set_default_voice",
            TTSMethods.VOICE_IMPORT_START: "voice_import_start",
            TTSMethods.VOICE_IMPORT_CHUNK: "voice_import_chunk",
            TTSMethods.VOICE_IMPORT_END: "voice_import_end",
            TTSMethods.VOICE_IMPORT_ABORT: "voice_import_abort",
            TTSMethods.CREATE_VOICE_PROFILE: "create_voice_profile",
            TTSMethods.DELETE_VOICE_PROFILE: "delete_voice_profile",
        }[method_id]
        metadata = getattr(TTSService, method_name)._contract_metadata
        assert metadata["method_id"] == method_id
        assert metadata["exposure"] == "both"
        if method_id in expected_use:
            assert metadata["method_type"] == "use"
            assert metadata["required_perms"] == ["TTS.use"]
            assert metadata["callable_feature_ids"] == ["speech_voice_discovery"]
        else:
            assert metadata["method_type"] == "manage"
            assert metadata["required_perms"] == ["TTS.manage"]
            assert metadata["callable_feature_ids"] == ["speech_voice_management"]


@pytest.mark.asyncio
async def test_voice_discovery_skips_provider_voices_without_exact_language(
    monkeypatch, mock_bus
) -> None:
    service = TTSService()
    service._provider = FakePocketProvider(None)
    fake_config = await _fake_config_for(
        Tts(provider="pockettts", providers=Providers(pockettts=Pockettts())),
        System(primary_language="en"),
    )
    monkeypatch.setattr("app.services.tts.service.config_api.aget", fake_config)

    voices = await service.list_voices(TTSListVoicesRequest())
    capabilities = await service.get_capabilities(TTSGetCapabilitiesRequest())

    assert voices.voices == []
    assert capabilities.capabilities.ready is True
    assert capabilities.capabilities.ready_languages == ["en"]


@pytest.mark.asyncio
async def test_remote_list_voices_omits_clones_until_visibility_support(mock_bus) -> None:
    service = TTSService()
    clone_id = "clone:00000000-0000-4000-8000-000000000001"
    service._provider = FakeVoiceListingProvider(
        (
            TTSVoiceInfo("standard:starter_en:alba", "Alba", True, "en"),
            TTSVoiceInfo(clone_id, "Clone", True, "en"),
        )
    )

    local = await service.list_voices(TTSListVoicesRequest())
    remote = await service.list_voices(
        TTSListVoicesRequest(),
        Envelope(
            type=TTSMethods.LIST_VOICES,
            payload={},
            origin="external",
            principal_id="principal-a",
            caller_peer_id="peer-a",
        ),
    )

    assert [voice.voice_id for voice in local.voices] == [
        "standard:starter_en:alba",
        clone_id,
    ]
    assert [voice.visible_scope for voice in local.voices] == ["public", "local"]
    assert [voice.voice_id for voice in remote.voices] == ["standard:starter_en:alba"]
    assert remote.voices[0].selection_mode == "shared_model_state"
    assert remote.voices[0].visible_scope == "public"


@pytest.mark.asyncio
async def test_use_safe_voice_list_stays_distinct_from_management_inventory(
    monkeypatch, mock_bus
) -> None:
    service = TTSService()
    clone_id = "clone:00000000-0000-4000-8000-000000000001"
    service._provider = FakeVoiceListingProvider(
        (
            TTSVoiceInfo("standard:starter_en:alba", "Alba", True, "en"),
            TTSVoiceInfo(clone_id, "Private Clone", True, "en"),
        )
    )
    FakeVoiceRegistry.installed = [
        types.SimpleNamespace(
            voice_id=clone_id,
            display_name="Private Clone",
            kind="clone",
            ready_state="ready",
            language_bundle="en",
            compatibility_group="pockettts-private-group",
            artifact_revision="clone-rev-private",
            artifact_refs=("artifacts/private/path/voice-state.safetensors",),
            source_retained=True,
            visibility="private",
        )
    ]
    fake_config = await _fake_config_for(
        Tts(provider="pockettts", providers=Providers(pockettts=Pockettts())),
        System(primary_language="en"),
    )
    monkeypatch.setattr("app.services.tts.service.config_api.aget", fake_config)
    monkeypatch.setattr("app.services.tts.service.VoiceRegistry", FakeVoiceRegistry)

    remote = await service.list_voices(
        TTSListVoicesRequest(),
        Envelope(
            type=TTSMethods.LIST_VOICES,
            payload={},
            origin="external",
            principal_id="principal-a",
            caller_peer_id="peer-a",
        ),
    )
    profiles = await service.list_voice_profiles(
        TTSListVoiceProfilesRequest(include_unavailable=True)
    )

    assert [voice.voice_id for voice in remote.voices] == ["standard:starter_en:alba"]
    assert "profiles" not in remote.model_dump()
    assert "allowed_peer_ids" not in remote.model_dump_json()
    profile_payload = profiles.model_dump(mode="json")
    clone_profile = next(
        profile for profile in profile_payload["profiles"] if profile["voice_id"] == clone_id
    )
    assert clone_profile["retained_source"] is True
    assert clone_profile["storage"]["artifact_count"] == 1
    encoded_profiles = profiles.model_dump_json()
    assert "artifact_refs" not in encoded_profiles
    assert "voice-state.safetensors" not in encoded_profiles
    assert "source_audio" not in encoded_profiles


@pytest.mark.asyncio
async def test_voice_import_audit_is_redacted_and_idempotency_is_payload_bound(
    mock_bus,
) -> None:
    mock_bus.request = AsyncMock()
    service = TTSService()
    envelope = Envelope(
        type=TTSMethods.VOICE_IMPORT_START,
        payload={},
        principal_id="principal-a",
        caller_peer_id="peer-a",
        correlation_id="corr-a",
    )
    payload = b"voice"
    digest = hashlib.sha256(payload).hexdigest()

    started = await service.voice_import_start(
        TTSVoiceImportStartRequest(
            operation_id="start-a",
            expected_total_bytes=len(payload),
            sha256=digest,
            format="wav",
            sample_rate=16000,
        ),
        envelope,
    )
    chunk = await service.voice_import_chunk(
        TTSVoiceImportChunkRequest(
            operation_id="chunk-a",
            upload_id=started.upload_id,
            sequence=0,
            chunk_data=base64.b64encode(payload).decode(),
            chunk_sha256=digest,
        ),
        envelope,
    )

    assert chunk.received_bytes == len(payload)
    with pytest.raises(ValueError, match="payload mismatch"):
        await service.voice_import_chunk(
            TTSVoiceImportChunkRequest(
                operation_id="chunk-a",
                upload_id=started.upload_id,
                sequence=0,
                chunk_data=base64.b64encode(b"other").decode(),
                chunk_sha256=hashlib.sha256(b"other").hexdigest(),
            ),
            envelope,
        )
    audit_call = mock_bus.request.await_args_list[-1]
    assert audit_call.args[0] == AuthMethods.STORE_AUDIT_EVENT
    details = audit_call.args[1].details
    assert details is not None
    assert "chunk_data" not in details
    assert "secrets_redacted" in details
    assert audit_call.kwargs["origin"] == "internal"
    assert audit_call.kwargs["timeout"] == 5.0


@pytest.mark.asyncio
async def test_voice_import_invalid_chunks_emit_redacted_rejected_audits(mock_bus) -> None:
    mock_bus.request = AsyncMock()
    service = TTSService()
    owner = Envelope(
        type=TTSMethods.VOICE_IMPORT_START,
        payload={},
        principal_id="principal-a",
        caller_peer_id="peer-a",
    )
    other_peer = Envelope(
        type=TTSMethods.VOICE_IMPORT_START,
        payload={},
        principal_id="principal-a",
        caller_peer_id="peer-b",
    )
    payload = b"voice"
    upload = await _start_voice_upload(service, owner, payload, operation_id="chunk-invalid")

    with pytest.raises(ValueError, match="unavailable"):
        await _append_voice_chunk(
            service, other_peer, upload.upload_id, payload, operation_id="chunk-wrong-owner"
        )
    _assert_redacted_rejection_audit(
        mock_bus,
        method="voice_import_chunk",
        forbidden=[upload.upload_id, base64.b64encode(payload).decode()],
    )

    with pytest.raises(ValueError, match="order"):
        await _append_voice_chunk(
            service, owner, upload.upload_id, payload, operation_id="chunk-gap", sequence=1
        )
    _assert_redacted_rejection_audit(
        mock_bus,
        method="voice_import_chunk",
        forbidden=[upload.upload_id, base64.b64encode(payload).decode()],
    )

    await _append_voice_chunk(
        service, owner, upload.upload_id, payload, operation_id="chunk-original"
    )
    duplicate = await _append_voice_chunk(
        service, owner, upload.upload_id, payload, operation_id="chunk-duplicate-same"
    )
    assert duplicate.status == "duplicate"
    _assert_outcome_audit(mock_bus, method="voice_import_chunk", status="duplicate")
    mismatch = b"other"
    with pytest.raises(ValueError, match="payload mismatch"):
        await _append_voice_chunk(
            service, owner, upload.upload_id, mismatch, operation_id="chunk-duplicate"
        )
    _assert_redacted_rejection_audit(
        mock_bus,
        method="voice_import_chunk",
        forbidden=[upload.upload_id, base64.b64encode(mismatch).decode()],
    )

    overflow_payload = b"12345"
    overflow_upload = await _start_voice_upload(
        service,
        owner,
        overflow_payload,
        operation_id="chunk-overflow-start",
        expected_total_bytes=4,
        sha256=hashlib.sha256(overflow_payload).hexdigest(),
    )
    with pytest.raises(ValueError, match="exceeds"):
        await _append_voice_chunk(
            service,
            owner,
            overflow_upload.upload_id,
            overflow_payload,
            operation_id="chunk-overflow",
        )
    _assert_redacted_rejection_audit(
        mock_bus,
        method="voice_import_chunk",
        forbidden=[overflow_upload.upload_id, base64.b64encode(overflow_payload).decode()],
    )


@pytest.mark.asyncio
async def test_voice_import_chunk_rejects_new_chunks_after_seal(mock_bus) -> None:
    mock_bus.request = AsyncMock()
    service = TTSService()
    owner = Envelope(type=TTSMethods.VOICE_IMPORT_START, payload={})
    started, sealed = await _sealed_voice_upload(service, owner)
    session = service._voice_import_sessions[started.upload_id]
    original_chunks = dict(session.chunks)
    original_sealed_ref = session.sealed_ref
    extra_payload = b"\1\0"

    with pytest.raises(ValueError, match="sealed"):
        await _append_voice_chunk(
            service,
            owner,
            started.upload_id,
            extra_payload,
            operation_id="chunk-after-seal",
            sequence=1,
        )

    assert sealed.sealed_audio_ref == original_sealed_ref
    assert session.sealed_ref == original_sealed_ref
    assert session.chunks == original_chunks
    assert not any(
        key[1] == "voice_import_chunk" and key[2] == "chunk-after-seal"
        for key in service._voice_operation_results
    )
    _assert_redacted_rejection_audit(
        mock_bus,
        method="voice_import_chunk",
        forbidden=[started.upload_id, base64.b64encode(extra_payload).decode()],
    )


@pytest.mark.asyncio
async def test_voice_import_invalid_end_attempts_emit_redacted_rejected_audits(
    mock_bus,
) -> None:
    mock_bus.request = AsyncMock()
    service = TTSService()
    owner = Envelope(
        type=TTSMethods.VOICE_IMPORT_START,
        payload={},
        principal_id="principal-a",
        caller_peer_id="peer-a",
    )
    other_peer = Envelope(
        type=TTSMethods.VOICE_IMPORT_START,
        payload={},
        principal_id="principal-a",
        caller_peer_id="peer-b",
    )
    payload = _wav_payload()
    digest = hashlib.sha256(payload).hexdigest()

    wrong_owner_upload = await _start_voice_upload(
        service, owner, payload, operation_id="end-wrong-owner-start"
    )
    await _append_voice_chunk(
        service, owner, wrong_owner_upload.upload_id, payload, operation_id="end-wrong-owner-chunk"
    )
    with pytest.raises(ValueError, match="unavailable"):
        await service.voice_import_end(
            TTSVoiceImportEndRequest(
                operation_id="end-wrong-owner",
                upload_id=wrong_owner_upload.upload_id,
                final_sequence=0,
                final_sha256=digest,
            ),
            other_peer,
        )
    _assert_redacted_rejection_audit(
        mock_bus, method="voice_import_end", forbidden=[wrong_owner_upload.upload_id]
    )

    sequence_upload = await _start_voice_upload(
        service, owner, payload, operation_id="end-sequence-start"
    )
    await _append_voice_chunk(
        service, owner, sequence_upload.upload_id, payload, operation_id="end-sequence-chunk"
    )
    with pytest.raises(ValueError, match="final sequence"):
        await service.voice_import_end(
            TTSVoiceImportEndRequest(
                operation_id="end-sequence",
                upload_id=sequence_upload.upload_id,
                final_sequence=1,
                final_sha256=digest,
            ),
            owner,
        )
    _assert_redacted_rejection_audit(
        mock_bus, method="voice_import_end", forbidden=[sequence_upload.upload_id]
    )

    length_upload = await _start_voice_upload(
        service,
        owner,
        payload,
        operation_id="end-length-start",
        expected_total_bytes=len(payload) + 1,
    )
    await _append_voice_chunk(
        service, owner, length_upload.upload_id, payload, operation_id="end-length-chunk"
    )
    with pytest.raises(ValueError, match="total bytes"):
        await service.voice_import_end(
            TTSVoiceImportEndRequest(
                operation_id="end-length",
                upload_id=length_upload.upload_id,
                final_sequence=0,
                final_sha256=digest,
            ),
            owner,
        )
    _assert_redacted_rejection_audit(
        mock_bus, method="voice_import_end", forbidden=[length_upload.upload_id]
    )

    hash_upload = await _start_voice_upload(service, owner, payload, operation_id="end-hash-start")
    await _append_voice_chunk(
        service, owner, hash_upload.upload_id, payload, operation_id="end-hash-chunk"
    )
    with pytest.raises(ValueError, match="digest"):
        await service.voice_import_end(
            TTSVoiceImportEndRequest(
                operation_id="end-hash",
                upload_id=hash_upload.upload_id,
                final_sequence=0,
                final_sha256="0" * 64,
            ),
            owner,
        )
    _assert_redacted_rejection_audit(
        mock_bus, method="voice_import_end", forbidden=[hash_upload.upload_id]
    )

    malformed_payload = b"voice"
    malformed_digest = hashlib.sha256(malformed_payload).hexdigest()
    malformed_upload = await _start_voice_upload(
        service,
        owner,
        malformed_payload,
        operation_id="end-audio-start",
        sha256=malformed_digest,
    )
    await _append_voice_chunk(
        service,
        owner,
        malformed_upload.upload_id,
        malformed_payload,
        operation_id="end-audio-chunk",
    )
    with pytest.raises(ValueError, match="wav voice import"):
        await service.voice_import_end(
            TTSVoiceImportEndRequest(
                operation_id="end-audio",
                upload_id=malformed_upload.upload_id,
                final_sequence=0,
                final_sha256=malformed_digest,
            ),
            owner,
        )
    _assert_redacted_rejection_audit(
        mock_bus,
        method="voice_import_end",
        forbidden=[malformed_upload.upload_id, "voice-import:"],
    )

    pcm_payload = b"\0\0" * 1600
    pcm_digest = hashlib.sha256(pcm_payload).hexdigest()
    pcm_upload = await _start_voice_upload(
        service,
        owner,
        pcm_payload,
        operation_id="end-pcm-duration-start",
        sha256=pcm_digest,
        audio_format="pcm_s16le",
        duration_ms=101,
    )
    await _append_voice_chunk(
        service,
        owner,
        pcm_upload.upload_id,
        pcm_payload,
        operation_id="end-pcm-duration-chunk",
    )
    with pytest.raises(ValueError, match="duration"):
        await service.voice_import_end(
            TTSVoiceImportEndRequest(
                operation_id="end-pcm-duration",
                upload_id=pcm_upload.upload_id,
                final_sequence=0,
                final_sha256=pcm_digest,
            ),
            owner,
        )
    _assert_redacted_rejection_audit(
        mock_bus, method="voice_import_end", forbidden=[pcm_upload.upload_id]
    )

    over_limit_payload = b"\0\0" * 15001
    over_limit_digest = hashlib.sha256(over_limit_payload).hexdigest()
    over_limit_upload = await _start_voice_upload(
        service,
        owner,
        over_limit_payload,
        operation_id="end-pcm-over-limit-start",
        sha256=over_limit_digest,
        audio_format="pcm_s16le",
        sample_rate=1000,
        duration_ms=None,
    )
    await _append_voice_chunk(
        service,
        owner,
        over_limit_upload.upload_id,
        over_limit_payload,
        operation_id="end-pcm-over-limit-chunk",
    )
    with pytest.raises(ValueError, match="duration exceeds limit"):
        await service.voice_import_end(
            TTSVoiceImportEndRequest(
                operation_id="end-pcm-over-limit",
                upload_id=over_limit_upload.upload_id,
                final_sequence=0,
                final_sha256=over_limit_digest,
            ),
            owner,
        )
    assert service._voice_import_sessions[over_limit_upload.upload_id].sealed_ref is None
    _assert_redacted_rejection_audit(
        mock_bus, method="voice_import_end", forbidden=[over_limit_upload.upload_id]
    )


@pytest.mark.asyncio
async def test_voice_import_end_accepts_valid_pcm_s16le(mock_bus) -> None:
    mock_bus.request = AsyncMock()
    service = TTSService()
    owner = Envelope(type=TTSMethods.VOICE_IMPORT_START, payload={})
    payload = b"\0\0" * 1600
    digest = hashlib.sha256(payload).hexdigest()

    started = await _start_voice_upload(
        service,
        owner,
        payload,
        operation_id="pcm-start",
        sha256=digest,
        audio_format="pcm_s16le",
        duration_ms=100,
    )
    await _append_voice_chunk(service, owner, started.upload_id, payload, operation_id="pcm-chunk")
    sealed = await service.voice_import_end(
        TTSVoiceImportEndRequest(
            operation_id="pcm-end",
            upload_id=started.upload_id,
            final_sequence=0,
            final_sha256=digest,
        ),
        owner,
    )

    assert sealed.status == "sealed"
    assert sealed.sealed_audio_ref == f"voice-import:{started.upload_id}"
    assert service._voice_import_sessions[started.upload_id].sealed_ref == sealed.sealed_audio_ref
    _assert_intent_attempt_audit(mock_bus, method="voice_import_end")


@pytest.mark.asyncio
async def test_voice_import_abort_audits_outcome_and_intent_branches(mock_bus) -> None:
    mock_bus.request = AsyncMock()
    service = TTSService()
    owner = Envelope(type=TTSMethods.VOICE_IMPORT_START, payload={})

    missing = await service.voice_import_abort(
        TTSVoiceImportAbortRequest(
            operation_id="abort-missing",
            upload_id="missing-upload",
        ),
        owner,
    )
    assert missing.status == "not_found"
    _assert_outcome_audit(mock_bus, method="voice_import_abort", status="not_found")

    payload = b"voice"
    started = await _start_voice_upload(service, owner, payload, operation_id="abort-start")
    await _append_voice_chunk(
        service, owner, started.upload_id, payload, operation_id="abort-chunk"
    )
    aborted = await service.voice_import_abort(
        TTSVoiceImportAbortRequest(
            operation_id="abort-present",
            upload_id=started.upload_id,
        ),
        owner,
    )

    assert aborted.status == "aborted"
    assert started.upload_id not in service._voice_import_sessions
    _assert_intent_attempt_audit(mock_bus, method="voice_import_abort")


@pytest.mark.asyncio
async def test_voice_import_start_fails_closed_when_audit_fails(mock_bus) -> None:
    mock_bus.request = AsyncMock(side_effect=RuntimeError("audit unavailable"))
    service = TTSService()
    payload = b"voice"

    with pytest.raises(RuntimeError, match="audit unavailable"):
        await service.voice_import_start(
            TTSVoiceImportStartRequest(
                operation_id="start-fail",
                expected_total_bytes=len(payload),
                sha256=hashlib.sha256(payload).hexdigest(),
                format="wav",
                sample_rate=16000,
            )
        )

    assert service._voice_import_sessions == {}
    assert service._voice_operation_results == {}


@pytest.mark.asyncio
async def test_concurrent_voice_import_starts_respect_capacity(mock_bus) -> None:
    mock_bus.request = AsyncMock()
    service = TTSService()
    service._voice_import_sessions = {
        f"existing-{index}": types.SimpleNamespace(
            owner="principal=principal-a|peer=peer-a",
            expires_at=datetime.now(UTC) + timedelta(minutes=15),
        )
        for index in range(7)
    }
    envelope = Envelope(
        type=TTSMethods.VOICE_IMPORT_START,
        payload={},
        principal_id="principal-a",
        caller_peer_id="peer-a",
    )
    payload = b"voice"
    digest = hashlib.sha256(payload).hexdigest()

    results = await asyncio.gather(
        *(
            service.voice_import_start(
                TTSVoiceImportStartRequest(
                    operation_id=f"start-race-{index}",
                    expected_total_bytes=len(payload),
                    sha256=digest,
                    format="wav",
                    sample_rate=16000,
                ),
                envelope,
            )
            for index in range(2)
        ),
        return_exceptions=True,
    )

    assert sum(not isinstance(result, Exception) for result in results) == 1
    assert sum(isinstance(result, ValueError) for result in results) == 1
    assert len(service._voice_import_sessions) == 8
    _assert_redacted_rejection_audit(mock_bus, method="voice_import_start", forbidden=[])


@pytest.mark.asyncio
async def test_voice_import_chunk_fails_closed_when_audit_fails(mock_bus) -> None:
    mock_bus.request = AsyncMock()
    service = TTSService()
    owner = Envelope(type=TTSMethods.VOICE_IMPORT_START, payload={})
    started = await service.voice_import_start(
        TTSVoiceImportStartRequest(
            operation_id="start-chunk-fail",
            expected_total_bytes=5,
            sha256=hashlib.sha256(b"voice").hexdigest(),
            format="wav",
            sample_rate=16000,
        ),
        owner,
    )
    mock_bus.request = AsyncMock(side_effect=RuntimeError("audit unavailable"))

    with pytest.raises(RuntimeError, match="audit unavailable"):
        await service.voice_import_chunk(
            TTSVoiceImportChunkRequest(
                operation_id="chunk-fail",
                upload_id=started.upload_id,
                sequence=0,
                chunk_data=base64.b64encode(b"voice").decode(),
                chunk_sha256=hashlib.sha256(b"voice").hexdigest(),
            ),
            owner,
        )

    assert service._voice_import_sessions[started.upload_id].chunks == {}
    assert not any(key[1] == "voice_import_chunk" for key in service._voice_operation_results)


@pytest.mark.asyncio
async def test_voice_import_end_and_abort_fail_closed_when_audit_fails(mock_bus) -> None:
    mock_bus.request = AsyncMock()
    service = TTSService()
    owner = Envelope(type=TTSMethods.VOICE_IMPORT_START, payload={})
    started, _sealed = await _sealed_voice_upload(service, owner)
    service._voice_operation_results = {
        key: value
        for key, value in service._voice_operation_results.items()
        if key[1] not in {"voice_import_end", "voice_import_abort"}
    }
    service._voice_import_sessions[started.upload_id].sealed_ref = None
    mock_bus.request = AsyncMock(side_effect=RuntimeError("audit unavailable"))

    with pytest.raises(RuntimeError, match="audit unavailable"):
        await service.voice_import_end(
            TTSVoiceImportEndRequest(
                operation_id="end-fail",
                upload_id=started.upload_id,
                final_sequence=0,
                final_sha256=hashlib.sha256(_wav_payload()).hexdigest(),
            ),
            owner,
        )
    assert service._voice_import_sessions[started.upload_id].sealed_ref is None

    with pytest.raises(RuntimeError, match="audit unavailable"):
        await service.voice_import_abort(
            TTSVoiceImportAbortRequest(
                operation_id="abort-fail",
                upload_id=started.upload_id,
            ),
            owner,
        )
    assert started.upload_id in service._voice_import_sessions


@pytest.mark.asyncio
async def test_voice_import_owner_and_create_profile_require_same_peer(mock_bus) -> None:
    mock_bus.request = AsyncMock()
    service = TTSService()
    owner = Envelope(
        type=TTSMethods.VOICE_IMPORT_START,
        payload={},
        principal_id="principal-a",
        caller_peer_id="peer-a",
    )
    other_peer = Envelope(
        type=TTSMethods.VOICE_IMPORT_START,
        payload={},
        principal_id="principal-a",
        caller_peer_id="peer-b",
    )
    payload = _wav_payload()
    digest = hashlib.sha256(payload).hexdigest()

    started = await service.voice_import_start(
        TTSVoiceImportStartRequest(
            operation_id="start-b",
            expected_total_bytes=len(payload),
            sha256=digest,
            format="wav",
            sample_rate=16000,
        ),
        owner,
    )
    with pytest.raises(ValueError, match="unavailable"):
        await service.voice_import_chunk(
            TTSVoiceImportChunkRequest(
                operation_id="chunk-other",
                upload_id=started.upload_id,
                sequence=0,
                chunk_data=base64.b64encode(payload).decode(),
                chunk_sha256=digest,
            ),
            other_peer,
        )
    await service.voice_import_chunk(
        TTSVoiceImportChunkRequest(
            operation_id="chunk-b",
            upload_id=started.upload_id,
            sequence=0,
            chunk_data=base64.b64encode(payload).decode(),
            chunk_sha256=digest,
        ),
        owner,
    )
    sealed = await service.voice_import_end(
        TTSVoiceImportEndRequest(
            operation_id="end-b",
            upload_id=started.upload_id,
            final_sequence=0,
            final_sha256=digest,
        ),
        owner,
    )

    rejected = await service.create_voice_profile(
        TTSCreateVoiceProfileRequest(
            operation_id="create-other",
            display_name="Clone",
            sealed_audio_ref=sealed.sealed_audio_ref,
            consent=True,
        ),
        other_peer,
    )
    unavailable = await service.create_voice_profile(
        TTSCreateVoiceProfileRequest(
            operation_id="create-owner",
            display_name="Clone",
            sealed_audio_ref=sealed.sealed_audio_ref,
            consent=True,
        ),
        owner,
    )

    assert rejected.status == "rejected"
    assert rejected.voice_id is None
    assert unavailable.status == "unavailable"
    assert unavailable.voice_id is None
    reused = await service.create_voice_profile(
        TTSCreateVoiceProfileRequest(
            operation_id="create-owner-again",
            display_name="Clone",
            sealed_audio_ref=sealed.sealed_audio_ref,
            consent=True,
        ),
        owner,
    )
    assert reused.status == "rejected"


@pytest.mark.asyncio
async def test_concurrent_create_profile_consumes_sealed_ref_once(mock_bus) -> None:
    mock_bus.request = AsyncMock()
    service = TTSService()
    owner = Envelope(type=TTSMethods.CREATE_VOICE_PROFILE, payload={})
    _started, sealed = await _sealed_voice_upload(service, owner)

    results = await asyncio.gather(
        *(
            service.create_voice_profile(
                TTSCreateVoiceProfileRequest(
                    operation_id=f"create-race-{index}",
                    display_name="Clone",
                    sealed_audio_ref=sealed.sealed_audio_ref,
                    consent=True,
                ),
                owner,
            )
            for index in range(2)
        )
    )

    assert sorted(result.status for result in results) == ["rejected", "unavailable"]


@pytest.mark.asyncio
async def test_install_voice_profile_prevalidates_configured_manifest(
    tmp_path, monkeypatch, mock_bus
) -> None:
    mock_bus.request = AsyncMock()
    manifest = tmp_path / "voices.manifest.json"
    manifest.write_text(
        '{"schema_version":1,"pack_id":"starter_en","pack_version":"1",'
        '"minimum_aurora_version":"1","minimum_runtime_version":"1","assets":[]}',
        encoding="utf-8",
    )
    fake_config = await _fake_config_for(
        Tts(
            provider="pockettts",
            voice_registry=VoiceRegistryConfig(
                manifest_path=str(manifest), cache_dir=str(tmp_path)
            ),
            providers=Providers(pockettts=Pockettts()),
        ),
        System(primary_language="en"),
    )
    monkeypatch.setattr("app.services.tts.service.config_api.aget", fake_config)
    monkeypatch.setattr("app.services.tts.service.VoiceRegistry", FakeVoiceRegistry)

    response = await TTSService().install_voice_profile(
        TTSInstallVoiceProfileRequest(
            operation_id="install-a",
            voice_id="standard:starter_en:alba",
        )
    )

    assert response.status == "not_found"
    assert FakeVoiceRegistry.install_calls == 0


@pytest.mark.asyncio
async def test_install_voice_profile_rejects_multi_asset_manifest(
    tmp_path, monkeypatch, mock_bus
) -> None:
    mock_bus.request = AsyncMock()
    manifest = tmp_path / "voices.manifest.json"
    asset = (
        '"asset_id":"alba","logical_voice_id":"standard:starter_en:alba",'
        '"display_name":"Alba","runtime_target":"pockettts-python",'
        '"language_bundle":"en","compatibility_group":"base",'
        '"artifact_revision":"rev1","feature":"voice-state","size_bytes":0,'
        f'"sha256":"{"0" * 64}","relative_path":"alba.safetensors",'
        '"compression":"none","unpacked_size_bytes":0,"license_name":"test",'
        '"redistribution":"approved"'
    )
    second = asset.replace("alba", "bela").replace(
        "standard:starter_en:bela", "standard:starter_en:bela"
    )
    manifest.write_text(
        '{"schema_version":1,"pack_id":"starter_en","pack_version":"1",'
        '"minimum_aurora_version":"1","minimum_runtime_version":"1","assets":[{'
        + asset
        + "},{"
        + second
        + "}]}",
        encoding="utf-8",
    )
    fake_config = await _fake_config_for(
        Tts(
            provider="pockettts",
            voice_registry=VoiceRegistryConfig(
                manifest_path=str(manifest), cache_dir=str(tmp_path)
            ),
            providers=Providers(pockettts=Pockettts()),
        ),
        System(primary_language="en"),
    )
    monkeypatch.setattr("app.services.tts.service.config_api.aget", fake_config)
    monkeypatch.setattr("app.services.tts.service.VoiceRegistry", FakeVoiceRegistry)

    response = await TTSService().install_voice_profile(
        TTSInstallVoiceProfileRequest(
            operation_id="install-multi",
            voice_id="standard:starter_en:alba",
        )
    )

    assert response.status == "rejected"
    assert FakeVoiceRegistry.install_calls == 0


@pytest.mark.asyncio
async def test_install_voice_profile_success_audits_intent_not_completed_outcome(
    tmp_path, monkeypatch, mock_bus
) -> None:
    mock_bus.request = AsyncMock()
    manifest = tmp_path / "voices.manifest.json"
    artifact = tmp_path / "alba.safetensors"
    artifact.write_bytes(b"")
    manifest.write_text(
        '{"schema_version":1,"pack_id":"starter_en","pack_version":"1",'
        '"minimum_aurora_version":"1","minimum_runtime_version":"1","assets":[{'
        '"asset_id":"alba","logical_voice_id":"standard:starter_en:alba",'
        '"display_name":"Alba","runtime_target":"pockettts-python",'
        '"language_bundle":"en","compatibility_group":"base",'
        '"artifact_revision":"rev1","feature":"voice-state","size_bytes":0,'
        f'"sha256":"{hashlib.sha256(b"").hexdigest()}","relative_path":"alba.safetensors",'
        '"compression":"none","unpacked_size_bytes":0,"license_name":"test",'
        '"redistribution":"approved"}]}',
        encoding="utf-8",
    )

    class InstallingVoiceRegistry(FakeVoiceRegistry):
        async def inventory(self):
            return []

        async def install_standard_pack(self, manifest_path, artifact_root):
            del manifest_path, artifact_root
            self.__class__.install_calls += 1
            return [
                types.SimpleNamespace(
                    voice_id="standard:starter_en:alba",
                    artifact_revision="rev1",
                )
            ]

    fake_config = await _fake_config_for(
        Tts(
            provider="pockettts",
            voice_registry=VoiceRegistryConfig(
                manifest_path=str(manifest), cache_dir=str(tmp_path)
            ),
            providers=Providers(pockettts=Pockettts()),
        ),
        System(primary_language="en"),
    )
    monkeypatch.setattr("app.services.tts.service.config_api.aget", fake_config)
    monkeypatch.setattr("app.services.tts.service.VoiceRegistry", InstallingVoiceRegistry)
    service = TTSService()

    response = await service.install_voice_profile(
        TTSInstallVoiceProfileRequest(
            operation_id="install-success",
            voice_id="standard:starter_en:alba",
        )
    )

    assert response.status == "installed"
    assert response.revision == "rev1"
    assert InstallingVoiceRegistry.install_calls == 1
    _assert_intent_attempt_audit(mock_bus, method="install_voice_profile")


@pytest.mark.asyncio
async def test_install_voice_profile_fails_closed_when_audit_fails(
    tmp_path, monkeypatch, mock_bus
) -> None:
    mock_bus.request = AsyncMock(side_effect=RuntimeError("audit unavailable"))
    manifest = tmp_path / "voices.manifest.json"
    artifact = tmp_path / "alba.safetensors"
    artifact.write_bytes(b"")
    manifest.write_text(
        '{"schema_version":1,"pack_id":"starter_en","pack_version":"1",'
        '"minimum_aurora_version":"1","minimum_runtime_version":"1","assets":[{'
        '"asset_id":"alba","logical_voice_id":"standard:starter_en:alba",'
        '"display_name":"Alba","runtime_target":"pockettts-python",'
        '"language_bundle":"en","compatibility_group":"base",'
        '"artifact_revision":"rev1","feature":"voice-state","size_bytes":0,'
        f'"sha256":"{hashlib.sha256(b"").hexdigest()}","relative_path":"alba.safetensors",'
        '"compression":"none","unpacked_size_bytes":0,"license_name":"test",'
        '"redistribution":"approved"}]}',
        encoding="utf-8",
    )
    fake_config = await _fake_config_for(
        Tts(
            provider="pockettts",
            voice_registry=VoiceRegistryConfig(
                manifest_path=str(manifest), cache_dir=str(tmp_path)
            ),
            providers=Providers(pockettts=Pockettts()),
        ),
        System(primary_language="en"),
    )
    monkeypatch.setattr("app.services.tts.service.config_api.aget", fake_config)
    monkeypatch.setattr("app.services.tts.service.VoiceRegistry", FakeVoiceRegistry)
    service = TTSService()

    with pytest.raises(RuntimeError, match="audit unavailable"):
        await service.install_voice_profile(
            TTSInstallVoiceProfileRequest(
                operation_id="install-audit-fail",
                voice_id="standard:starter_en:alba",
            )
        )

    assert FakeVoiceRegistry.install_calls == 0
    assert service._voice_revision == 0
    assert service._voice_operation_results == {}


@pytest.mark.asyncio
async def test_delete_voice_profile_rejects_active_clone(monkeypatch, mock_bus) -> None:
    mock_bus.request = AsyncMock()
    clone_id = "clone:00000000-0000-4000-8000-000000000001"
    FakeVoiceRegistry.installed = [
        types.SimpleNamespace(
            voice_id=clone_id,
            display_name="Clone",
            kind="clone",
            visibility="private",
            ready_state="ready",
            runtime_target="pockettts-python",
            language_bundle="en",
            compatibility_group="base",
            artifact_revision="rev1",
            artifact_refs=("artifacts/clone/voice-state.safetensors",),
            source_retained=False,
        )
    ]
    fake_config = await _fake_config_for(
        Tts(provider="pockettts", providers=Providers(pockettts=Pockettts())),
        System(primary_language="en"),
    )
    monkeypatch.setattr("app.services.tts.service.config_api.aget", fake_config)
    monkeypatch.setattr("app.services.tts.service.VoiceRegistry", FakeVoiceRegistry)
    service = TTSService()
    service._provider = FakeVoiceListingProvider((), active_voice=clone_id)

    response = await service.delete_voice_profile(
        TTSDeleteVoiceProfileRequest(
            operation_id="delete-active",
            voice_id=clone_id,
        )
    )

    assert response.status == "rejected"
    assert FakeVoiceRegistry.deleted == []


@pytest.mark.asyncio
async def test_delete_voice_profile_success_audits_intent_not_completed_outcome(
    monkeypatch, mock_bus
) -> None:
    mock_bus.request = AsyncMock()
    clone_id = "clone:00000000-0000-4000-8000-000000000001"
    FakeVoiceRegistry.installed = [
        types.SimpleNamespace(
            voice_id=clone_id,
            display_name="Clone",
            kind="clone",
            visibility="private",
            ready_state="ready",
            runtime_target="pockettts-python",
            language_bundle="en",
            compatibility_group="base",
            artifact_revision="rev1",
            artifact_refs=("artifacts/clone/voice-state.safetensors",),
            source_retained=False,
        )
    ]
    fake_config = await _fake_config_for(
        Tts(provider="pockettts", providers=Providers(pockettts=Pockettts())),
        System(primary_language="en"),
    )
    monkeypatch.setattr("app.services.tts.service.config_api.aget", fake_config)
    monkeypatch.setattr("app.services.tts.service.VoiceRegistry", FakeVoiceRegistry)
    service = TTSService()
    service._provider = FakeVoiceListingProvider((), active_voice=None)

    response = await service.delete_voice_profile(
        TTSDeleteVoiceProfileRequest(
            operation_id="delete-success",
            voice_id=clone_id,
        )
    )

    assert response.status == "deleted"
    assert FakeVoiceRegistry.deleted == [clone_id]
    _assert_intent_attempt_audit(mock_bus, method="delete_voice_profile")


@pytest.mark.asyncio
async def test_delete_voice_profile_fails_closed_when_audit_fails(monkeypatch, mock_bus) -> None:
    mock_bus.request = AsyncMock(side_effect=RuntimeError("audit unavailable"))
    clone_id = "clone:00000000-0000-4000-8000-000000000001"
    FakeVoiceRegistry.installed = [
        types.SimpleNamespace(
            voice_id=clone_id,
            display_name="Clone",
            kind="clone",
            visibility="private",
            ready_state="ready",
            runtime_target="pockettts-python",
            language_bundle="en",
            compatibility_group="base",
            artifact_revision="rev1",
            artifact_refs=("artifacts/clone/voice-state.safetensors",),
            source_retained=False,
        )
    ]
    fake_config = await _fake_config_for(
        Tts(provider="pockettts", providers=Providers(pockettts=Pockettts())),
        System(primary_language="en"),
    )
    monkeypatch.setattr("app.services.tts.service.config_api.aget", fake_config)
    monkeypatch.setattr("app.services.tts.service.VoiceRegistry", FakeVoiceRegistry)
    service = TTSService()
    service._provider = FakeVoiceListingProvider((), active_voice=None)

    with pytest.raises(RuntimeError, match="audit unavailable"):
        await service.delete_voice_profile(
            TTSDeleteVoiceProfileRequest(
                operation_id="delete-audit-fail",
                voice_id=clone_id,
            )
        )

    assert FakeVoiceRegistry.deleted == []
    assert service._voice_revision == 0
    assert service._voice_operation_results == {}


@pytest.mark.asyncio
async def test_tts_on_stop_clears_voice_management_state(mock_bus) -> None:
    service = TTSService()
    service._voice_import_sessions["upload"] = types.SimpleNamespace()
    service._voice_operation_results[("owner", "method", "op")] = ("hash", object())

    await service.on_stop()

    assert service._voice_import_sessions == {}
    assert service._voice_operation_results == {}


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
