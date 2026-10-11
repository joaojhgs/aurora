from __future__ import annotations

import asyncio
from collections.abc import Sequence
from contextlib import suppress
from unittest.mock import AsyncMock

import pytest

from app.messaging import Envelope
from app.messaging.bus import QueryResult
from app.services.tts.providers.base import (
    TTSProviderCapabilities,
    TTSProviderError,
    TTSProviderHealth,
    TTSSynthesisResult,
    TTSVoiceInfo,
    VoiceSelectionMode,
)
from app.services.tts.service import TTSService
from app.shared.contracts.models.gateway import (
    GatewayMethods,
    GetMeshStatusResponse,
    MeshLocalStatus,
)
from app.shared.contracts.models.speech_runtime import SpeechStageCapabilityExportV1
from app.shared.contracts.models.tts import TTSMethods, TTSSynthesizeRequest


class _AnnouncementProvider:
    def __init__(
        self,
        *,
        ready: bool = True,
        voices: Sequence[TTSVoiceInfo] = (),
        health_error: str | None = None,
        supported_formats: tuple[str, ...] = ("raw", "wav"),
        base_identity: str = "fixture:base:sha256:0123456789abcdef01234567",
    ) -> None:
        self.ready = ready
        self.voices = tuple(voices)
        self.health_error = health_error
        self.supported_formats = supported_formats
        self.base_identity = base_identity
        self.events: list[str] = []
        self.synthesis_requests = []

    @property
    def capabilities(self) -> TTSProviderCapabilities:
        return TTSProviderCapabilities(
            provider_id="fixture-provider",
            voice_selection_mode=VoiceSelectionMode.ACTIVE_ONLY,
            supports_finite_synthesis=True,
            supports_streaming=False,
            supported_formats=self.supported_formats,
        )

    async def health(self) -> TTSProviderHealth:
        self.events.append("health")
        return TTSProviderHealth(
            provider_id="fixture-provider",
            ready=self.ready,
            active_voice="standard:starter_en:alba",
            base_identity=self.base_identity,
            error=self.health_error,
        )

    async def list_voices(self) -> tuple[TTSVoiceInfo, ...]:
        self.events.append("voices")
        return self.voices

    async def synthesize(self, request) -> TTSSynthesisResult:
        self.synthesis_requests.append(request)
        return TTSSynthesisResult(
            audio=b"\x01\x00\x02\x00",
            audio_format=request.audio_format,
            sample_rate=request.sample_rate or 22050,
            channels=1,
            duration_ms=len(b"\x01\x00\x02\x00") / (22050 * 2) * 1000,
            voice=request.voice,
        )


class _MeshStatusBus:
    def __init__(self, response: QueryResult) -> None:
        self.response = response
        self.request = AsyncMock(return_value=response)


def _ready_voice_inventory() -> tuple[TTSVoiceInfo, ...]:
    return (
        TTSVoiceInfo("standard:starter_en:alba", "Alba", True, "en"),
        TTSVoiceInfo("standard:starter_en:unready", "Unready", False, "en"),
        TTSVoiceInfo("clone:123e4567-e89b-42d3-a456-426614174000", "Private", True, "en"),
        TTSVoiceInfo("../../private/model.bin", "Malformed", True, "en"),
    )


def _mesh_status(peer_id: str | None = "local-peer", *, as_dict: bool = False) -> QueryResult:
    response = GetMeshStatusResponse(local=MeshLocalStatus(peer_id=peer_id))
    return QueryResult(
        ok=True,
        data=response.model_dump(mode="json") if as_dict else response,
    )


def _service_with_bus(monkeypatch, response: QueryResult) -> tuple[TTSService, _MeshStatusBus]:
    bus = _MeshStatusBus(response)
    monkeypatch.setattr("app.shared.services.base_service.get_bus_singleton", lambda: bus)
    service = TTSService()
    monkeypatch.setattr(service, "_effective_tts_language", AsyncMock(return_value="en"))
    return service, bus


@pytest.mark.asyncio
@pytest.mark.parametrize("mesh_as_dict", (False, True), ids=("typed", "serialized"))
async def test_ready_finite_announcement_uses_mesh_peer_and_public_ready_voices(
    monkeypatch,
    mesh_as_dict: bool,
) -> None:
    service, bus = _service_with_bus(
        monkeypatch,
        _mesh_status("mesh-peer-a", as_dict=mesh_as_dict),
    )
    provider = _AnnouncementProvider(voices=_ready_voice_inventory())
    service._provider = provider
    service._voice_revision = 7

    exports = await service._speech_stage_capabilities_for_announcement()

    assert len(exports) == 1
    assert isinstance(exports[0], SpeechStageCapabilityExportV1)
    capability = exports[0].capability
    assert capability.peer_id == "mesh-peer-a"
    assert capability.method_ids == [TTSMethods.SYNTHESIZE]
    assert capability.required_permissions == [TTSMethods.SYNTHESIZE]
    assert capability.modes == ["finite"]
    assert capability.readiness == "ready"
    assert capability.exported is True
    assert capability.capability_revision == 7
    assert capability.supported_formats == ["raw", "wav"]
    assert capability.supported_languages == ["en"]
    assert capability.sample_rates == []
    assert capability.model_ids == [provider.base_identity]
    assert exports[0].voice_ids == ("standard:starter_en:alba",)
    assert exports[0].requires_remote_audio_egress is True
    assert provider.events == ["health", "voices", "health"]
    bus.request.assert_awaited_once()
    assert bus.request.await_args.args[0] == GatewayMethods.GET_MESH_STATUS

    rendered = str(exports[0].model_dump(mode="json"))
    assert "secret.bin" not in rendered
    assert "private provider error" not in rendered
    assert "clone:123e4567-e89b-42d3-a456-426614174000" not in rendered
    assert "../../private/model.bin" not in rendered

    capability.model_ids.append("mutated")
    assert exports[0].capability.model_ids == [provider.base_identity]

    service._provider = _AnnouncementProvider(
        voices=_ready_voice_inventory(), base_identity="/private/models/secret.bin"
    )
    assert await service._speech_stage_capabilities_for_announcement() == []


@pytest.mark.asyncio
async def test_explicit_model_selector_requires_current_healthy_provider_before_synthesis() -> None:
    provider = _AnnouncementProvider(voices=_ready_voice_inventory())
    service = TTSService()
    service._provider = provider

    with pytest.raises(TTSProviderError, match="^TTS model is unavailable$"):
        await service.synthesize(
            TTSSynthesizeRequest(text="selector mismatch", model_id="fixture:other", format="raw")
        )
    assert provider.synthesis_requests == []

    response = await service.synthesize(
        TTSSynthesizeRequest(text="selector match", model_id=provider.base_identity, format="raw")
    )
    assert len(provider.synthesis_requests) == 1
    assert response.format == "raw"


@pytest.mark.parametrize(
    ("provider", "mesh_response"),
    (
        (None, _mesh_status()),
        (
            _AnnouncementProvider(
                ready=False,
                voices=_ready_voice_inventory(),
                health_error="private provider error",
            ),
            _mesh_status(),
        ),
        (
            _AnnouncementProvider(
                voices=(TTSVoiceInfo("standard:starter_en:alba", "Alba", False, "en"),)
            ),
            _mesh_status(),
        ),
        (
            _AnnouncementProvider(
                voices=_ready_voice_inventory(),
                supported_formats=("wav",),
            ),
            _mesh_status(),
        ),
        (_AnnouncementProvider(voices=_ready_voice_inventory()), _mesh_status(None)),
        (
            _AnnouncementProvider(voices=_ready_voice_inventory()),
            QueryResult(ok=False, error="mesh status unavailable"),
        ),
        (
            _AnnouncementProvider(voices=_ready_voice_inventory()),
            QueryResult(ok=True, data={"local": {"peer_id": 42}}),
        ),
    ),
    ids=(
        "no-provider",
        "unready",
        "no-ready-public-voice",
        "wav-only-provider",
        "missing-mesh-peer",
        "mesh-status-error",
        "malformed-mesh-status",
    ),
)
@pytest.mark.asyncio
async def test_announcement_fails_closed_without_runtime_ready_public_identity(
    monkeypatch,
    provider: _AnnouncementProvider | None,
    mesh_response: QueryResult,
) -> None:
    service, _ = _service_with_bus(monkeypatch, mesh_response)
    if provider is not None:
        service._provider = provider

    assert await service._speech_stage_capabilities_for_announcement() == []


@pytest.mark.asyncio
async def test_voice_descriptors_skip_malformed_ids_and_keep_clone_scope_local(monkeypatch) -> None:
    service, _ = _service_with_bus(monkeypatch, _mesh_status())
    service._provider = _AnnouncementProvider(voices=_ready_voice_inventory())

    local = await service._list_voice_descriptors()
    external = await service._list_voice_descriptors(
        Envelope(
            type=TTSMethods.LIST_VOICES,
            payload={},
            origin="external",
            principal_id="principal-a",
            caller_peer_id="peer-a",
        )
    )

    assert [voice.voice_id for voice in local] == [
        "standard:starter_en:alba",
        "clone:123e4567-e89b-42d3-a456-426614174000",
    ]
    assert [voice.visible_scope for voice in local] == ["public", "local"]
    assert [voice.voice_id for voice in external] == ["standard:starter_en:alba"]
    assert [voice.visible_scope for voice in external] == ["public"]


@pytest.mark.asyncio
async def test_provider_replacement_during_deferred_health_does_not_publish_stale_stage(
    monkeypatch,
) -> None:
    entered = asyncio.Event()
    release = asyncio.Event()

    class DeferredProvider(_AnnouncementProvider):
        async def health(self) -> TTSProviderHealth:
            self.events.append("health")
            entered.set()
            await release.wait()
            return await super().health()

    service, _ = _service_with_bus(monkeypatch, _mesh_status())
    provider = DeferredProvider(voices=_ready_voice_inventory())
    service._provider = provider

    task = asyncio.create_task(service._speech_stage_capabilities_for_announcement())
    entry_waiter = asyncio.create_task(entered.wait())
    try:
        await asyncio.wait(
            {task, entry_waiter},
            return_when=asyncio.FIRST_COMPLETED,
        )
        assert entered.is_set(), "announcement hook returned before reading provider health"
        service._provider = _AnnouncementProvider(voices=_ready_voice_inventory())
        release.set()
        assert await task == []
    finally:
        release.set()
        if not entry_waiter.done():
            entry_waiter.cancel()
        with suppress(asyncio.CancelledError):
            await entry_waiter
        if not task.done():
            task.cancel()
        with suppress(asyncio.CancelledError, Exception):
            await task


@pytest.mark.asyncio
async def test_voice_revision_change_during_voice_read_does_not_publish_stale_stage(
    monkeypatch,
) -> None:
    entered = asyncio.Event()
    release = asyncio.Event()

    class DeferredVoiceProvider(_AnnouncementProvider):
        async def list_voices(self) -> tuple[TTSVoiceInfo, ...]:
            self.events.append("voices")
            entered.set()
            await release.wait()
            return self.voices

    service, _ = _service_with_bus(monkeypatch, _mesh_status())
    service._provider = DeferredVoiceProvider(voices=_ready_voice_inventory())

    task = asyncio.create_task(service._speech_stage_capabilities_for_announcement())
    entry_waiter = asyncio.create_task(entered.wait())
    try:
        await asyncio.wait(
            {task, entry_waiter},
            return_when=asyncio.FIRST_COMPLETED,
        )
        assert entered.is_set(), "announcement hook returned before listing provider voices"
        service._voice_revision += 1
        release.set()
        assert await task == []
    finally:
        release.set()
        if not entry_waiter.done():
            entry_waiter.cancel()
        with suppress(asyncio.CancelledError):
            await entry_waiter
        if not task.done():
            task.cancel()
        with suppress(asyncio.CancelledError, Exception):
            await task
