"""Finite synthesis must bind an explicit voice to the current ready provider."""

from __future__ import annotations

import asyncio
import base64
import io
import wave
from contextlib import suppress

import pytest

from app.services.tts.providers.base import TTSSynthesisResult, TTSVoiceInfo
from app.services.tts.service import TTSService
from app.shared.contracts.models.tts import TTSSynthesizeRequest

_PCM = b"\x01\x00\x02\x00"


class _VoiceProvider:
    def __init__(self, voices: tuple[TTSVoiceInfo, ...]) -> None:
        self.voices = voices
        self.synthesis_requests = []

    async def list_voices(self) -> tuple[TTSVoiceInfo, ...]:
        return self.voices

    async def synthesize(self, request) -> TTSSynthesisResult:
        self.synthesis_requests.append(request)
        return TTSSynthesisResult(
            audio=_PCM,
            audio_format=request.audio_format,
            sample_rate=22050,
            channels=1,
            duration_ms=len(_PCM) / (22050 * 2) * 1000,
            voice=request.voice,
        )


class _DeferredVoiceProvider(_VoiceProvider):
    def __init__(self) -> None:
        super().__init__((TTSVoiceInfo("standard:test:ready", "Ready", True),))
        self.enumeration_entered = asyncio.Event()
        self.release_enumeration = asyncio.Event()

    async def list_voices(self) -> tuple[TTSVoiceInfo, ...]:
        self.enumeration_entered.set()
        await self.release_enumeration.wait()
        return self.voices


class _DefaultOnlyProvider:
    """Legacy default-only providers need not implement voice enumeration."""

    def __init__(self) -> None:
        self.synthesis_requests = []

    async def synthesize(self, request) -> TTSSynthesisResult:
        self.synthesis_requests.append(request)
        return TTSSynthesisResult(
            audio=_PCM,
            audio_format=request.audio_format,
            sample_rate=22050,
            channels=1,
            duration_ms=len(_PCM) / (22050 * 2) * 1000,
            voice="provider-default",
        )


class _BrokenVoiceProvider(_DefaultOnlyProvider):
    async def list_voices(self) -> tuple[TTSVoiceInfo, ...]:
        raise RuntimeError("private model path /secret/model and request text leaked")


def _decode_wav(encoded: str) -> tuple[bytes, int]:
    with wave.open(io.BytesIO(base64.b64decode(encoded)), "rb") as wav_file:
        assert wav_file.getnchannels() == 1
        assert wav_file.getsampwidth() == 2
        return wav_file.readframes(wav_file.getnframes()), wav_file.getframerate()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("voice_id", "audio_format"),
    [
        ("standard:test:ready", "raw"),
        ("standard:test:ready", "wav"),
        ("clone:00000000-0000-4000-8000-000000000001", "raw"),
        ("clone:00000000-0000-4000-8000-000000000001", "wav"),
    ],
)
async def test_explicit_ready_standard_and_legacy_clone_voices_are_synthesized_exactly(
    voice_id: str, audio_format: str
) -> None:
    voices = (
        TTSVoiceInfo("standard:test:ready", "Ready", True),
        TTSVoiceInfo("clone:00000000-0000-4000-8000-000000000001", "Saved voice", True),
    )
    service = TTSService()
    provider = _VoiceProvider(voices)
    service._provider = provider

    response = await service.synthesize(
        TTSSynthesizeRequest(text="voice selection", voice=voice_id, format=audio_format)
    )

    assert len(provider.synthesis_requests) == 1
    assert provider.synthesis_requests[0].voice == voice_id
    assert response.format == audio_format
    if audio_format == "raw":
        assert base64.b64decode(response.audio_data) == _PCM
    else:
        assert _decode_wav(response.audio_data) == (_PCM, 22050)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "voices",
    [
        (),
        (TTSVoiceInfo("standard:test:requested", "Requested", False),),
    ],
    ids=["absent", "not-ready"],
)
async def test_explicit_absent_or_unready_voice_is_rejected_before_provider_synthesis(
    voices: tuple[TTSVoiceInfo, ...],
) -> None:
    service = TTSService()
    provider = _VoiceProvider(voices)
    service._provider = provider

    with pytest.raises(RuntimeError, match="^TTS voice is unavailable$"):
        await service.synthesize(
            TTSSynthesizeRequest(
                text="do not synthesize with a substitute",
                voice="standard:test:requested",
                format="raw",
            )
        )

    assert provider.synthesis_requests == []


@pytest.mark.asyncio
async def test_explicit_voice_fails_closed_when_provider_cannot_enumerate_voices() -> None:
    service = TTSService()
    provider = _DefaultOnlyProvider()
    service._provider = provider

    with pytest.raises(RuntimeError, match="^TTS voice is unavailable$"):
        await service.synthesize(
            TTSSynthesizeRequest(
                text="explicit voice requires current readiness",
                voice="standard:test:requested",
                format="raw",
            )
        )

    assert provider.synthesis_requests == []


@pytest.mark.asyncio
async def test_explicit_voice_enumeration_error_is_sanitized_before_synthesis() -> None:
    service = TTSService()
    provider = _BrokenVoiceProvider()
    service._provider = provider

    with pytest.raises(RuntimeError, match="^TTS voice is unavailable$") as exc_info:
        await service.synthesize(
            TTSSynthesizeRequest(
                text="private request text",
                voice="standard:test:requested",
                format="raw",
            )
        )

    assert "secret" not in str(exc_info.value)
    assert "private request text" not in str(exc_info.value)
    assert provider.synthesis_requests == []


@pytest.mark.asyncio
async def test_voice_none_preserves_legacy_default_without_voice_enumeration() -> None:
    service = TTSService()
    provider = _DefaultOnlyProvider()
    service._provider = provider

    response = await service.synthesize(TTSSynthesizeRequest(text="legacy default", format="raw"))

    assert len(provider.synthesis_requests) == 1
    assert provider.synthesis_requests[0].voice is None
    assert response.format == "raw"
    assert base64.b64decode(response.audio_data) == _PCM


@pytest.mark.asyncio
async def test_provider_replacement_during_voice_enumeration_blocks_all_synthesis() -> None:
    service = TTSService()
    retired = _DeferredVoiceProvider()
    replacement = _VoiceProvider((TTSVoiceInfo("standard:test:ready", "Ready", True),))
    service._provider = retired
    task = asyncio.create_task(
        service.synthesize(
            TTSSynthesizeRequest(
                text="provider changes during voice check",
                voice="standard:test:ready",
                format="raw",
            )
        )
    )

    try:
        await asyncio.wait_for(retired.enumeration_entered.wait(), timeout=5)
        service._provider = replacement
        retired.release_enumeration.set()
        with pytest.raises(RuntimeError, match="^TTS voice is unavailable$"):
            await task
        assert retired.synthesis_requests == []
        assert replacement.synthesis_requests == []
    finally:
        retired.release_enumeration.set()
        if not task.done():
            task.cancel()
        with suppress(BaseException):
            await task


@pytest.mark.asyncio
async def test_voice_revision_change_during_voice_enumeration_blocks_synthesis() -> None:
    service = TTSService()
    provider = _DeferredVoiceProvider()
    service._provider = provider
    task = asyncio.create_task(
        service.synthesize(
            TTSSynthesizeRequest(
                text="voice changes during voice check",
                voice="standard:test:ready",
                format="raw",
            )
        )
    )

    try:
        await asyncio.wait_for(provider.enumeration_entered.wait(), timeout=5)
        service._voice_revision += 1
        provider.release_enumeration.set()
        with pytest.raises(RuntimeError, match="^TTS voice is unavailable$"):
            await task
        assert provider.synthesis_requests == []
    finally:
        provider.release_enumeration.set()
        if not task.done():
            task.cancel()
        with suppress(BaseException):
            await task


@pytest.mark.asyncio
async def test_cancellation_during_voice_enumeration_propagates_without_synthesis() -> None:
    service = TTSService()
    provider = _DeferredVoiceProvider()
    service._provider = provider
    task = asyncio.create_task(
        service.synthesize(
            TTSSynthesizeRequest(
                text="cancel while checking voice",
                voice="standard:test:ready",
                format="raw",
            )
        )
    )

    try:
        await asyncio.wait_for(provider.enumeration_entered.wait(), timeout=5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert provider.synthesis_requests == []
    finally:
        provider.release_enumeration.set()
        if not task.done():
            task.cancel()
        with suppress(BaseException):
            await task
