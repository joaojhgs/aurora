"""Finite TTS results must belong to the provider generation that produced them."""

from __future__ import annotations

import asyncio
import base64
import io
import wave
from contextlib import suppress

import pytest

from app.services.tts.providers.base import TTSSynthesisResult
from app.services.tts.service import TTSService
from app.shared.contracts.models.tts import TTSSynthesizeRequest


class _Provider:
    def __init__(
        self,
        audio: bytes,
        *,
        entered: asyncio.Event | None = None,
        release: asyncio.Event | None = None,
    ) -> None:
        self.audio = audio
        self.entered = entered
        self.release = release
        self.calls = 0

    async def synthesize(self, request) -> TTSSynthesisResult:
        self.calls += 1
        if self.entered is not None:
            self.entered.set()
        if self.release is not None:
            await self.release.wait()
        return TTSSynthesisResult(
            audio=self.audio,
            audio_format=request.audio_format,
            sample_rate=22050,
            channels=1,
            duration_ms=len(self.audio) / (22050 * 2) * 1000,
            voice=request.voice or "default",
        )


def _decode_wav(encoded_audio: str) -> tuple[bytes, int]:
    with wave.open(io.BytesIO(base64.b64decode(encoded_audio)), "rb") as wav_file:
        assert wav_file.getnchannels() == 1
        assert wav_file.getsampwidth() == 2
        return wav_file.readframes(wav_file.getnframes()), wav_file.getframerate()


@pytest.mark.asyncio
@pytest.mark.parametrize("audio_format", ["raw", "wav"])
async def test_finite_synthesis_returns_audio_for_unchanged_provider_generation(audio_format: str):
    service = TTSService()
    pcm = b"\x01\x00\x02\x00"
    provider = _Provider(pcm)
    service._provider = provider

    response = await service.synthesize(
        TTSSynthesizeRequest(text="generation stable", format=audio_format)
    )

    assert provider.calls == 1
    assert response.format == audio_format
    if audio_format == "raw":
        assert base64.b64decode(response.audio_data) == pcm
    else:
        assert _decode_wav(response.audio_data) == (pcm, 22050)


@pytest.mark.asyncio
async def test_provider_replacement_during_finite_synthesis_cannot_return_retired_audio():
    service = TTSService()
    entered = asyncio.Event()
    release = asyncio.Event()
    retired = _Provider(b"\x11\x00\x12\x00", entered=entered, release=release)
    replacement = _Provider(b"\x21\x00\x22\x00")
    service._provider = retired
    task = asyncio.create_task(
        service.synthesize(TTSSynthesizeRequest(text="provider replacement", format="raw"))
    )

    try:
        await asyncio.wait_for(entered.wait(), timeout=5)
        assert retired.calls == 1, "provider synthesis must be entered before replacement"
        service._provider = replacement
        release.set()
        with pytest.raises(RuntimeError):
            await task
        assert replacement.calls == 0
    finally:
        release.set()
        if not task.done():
            task.cancel()
        with suppress(BaseException):
            await task


@pytest.mark.asyncio
async def test_voice_revision_change_during_finite_synthesis_cannot_return_old_audio():
    service = TTSService()
    entered = asyncio.Event()
    release = asyncio.Event()
    provider = _Provider(b"\x31\x00\x32\x00", entered=entered, release=release)
    service._provider = provider
    task = asyncio.create_task(
        service.synthesize(TTSSynthesizeRequest(text="voice revision", format="raw"))
    )

    try:
        await asyncio.wait_for(entered.wait(), timeout=5)
        assert provider.calls == 1, "provider synthesis must be entered before revision changes"
        service._voice_revision += 1
        release.set()
        with pytest.raises(RuntimeError):
            await task
    finally:
        release.set()
        if not task.done():
            task.cancel()
        with suppress(BaseException):
            await task
