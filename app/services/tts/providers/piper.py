"""Piper TTS provider."""

from __future__ import annotations

import asyncio
import hashlib
import io
import os
import subprocess
import tempfile
import wave
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path

from app.helpers.aurora_logger import log_debug, log_warning
from app.services.tts.providers.base import (
    TTSProviderCapabilities,
    TTSProviderError,
    TTSProviderHealth,
    TTSStreamChunk,
    TTSSynthesisRequest,
    TTSSynthesisResult,
    TTSVoiceInfo,
    VoiceSelectionMode,
)


@dataclass(frozen=True)
class PiperVoiceConfig:
    """Piper model/config pair."""

    voice_id: str
    model_file: str
    config_file: str | None = None
    display_name: str = "Piper"


def pcm_to_wav_bytes(audio: bytes, *, sample_rate: int, channels: int = 1) -> bytes:
    """Wrap 16-bit PCM audio in a WAV container."""
    wav_buffer = io.BytesIO()
    with wave.open(wav_buffer, "wb") as wav_file:
        wav_file.setnchannels(channels)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(audio)
    return wav_buffer.getvalue()


def _absolute_path(path: str) -> str:
    return path if os.path.isabs(path) else os.path.abspath(path)


def _file_digest(path: str | None) -> str:
    """Return a stable file-content digest without exposing the path."""
    if not path:
        return "none"
    if not Path(path).exists():
        return "missing"
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _piper_base_identity(voice: PiperVoiceConfig) -> str:
    """Return a collision-resistant resident identity without filesystem paths."""
    model_path = _absolute_path(voice.model_file)
    config_path = _absolute_path(voice.config_file) if voice.config_file else None
    identity = hashlib.sha256()
    identity.update(b"piper-provider-v1")
    identity.update(b"\0model:")
    identity.update(_file_digest(model_path).encode("ascii"))
    identity.update(b"\0config:")
    identity.update(_file_digest(config_path).encode("ascii"))
    return f"piper:{voice.voice_id}:sha256:{identity.hexdigest()[:24]}"


def synthesize_piper_cli(
    *,
    piper_path: str,
    voice: PiperVoiceConfig,
    text: str,
    use_cuda: bool = False,
    debug: bool = False,
) -> tuple[bytes, int]:
    """Run Piper synchronously and return raw 16-bit mono PCM plus sample rate."""
    model_file = _absolute_path(voice.model_file)
    if not Path(model_file).exists():
        raise TTSProviderError("unavailable", "Piper voice model is unavailable")

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp_wav_file:
        output_wav_path = tmp_wav_file.name

    try:
        cmd_list = [piper_path, "-m", model_file, "-f", output_wav_path]
        if voice.config_file:
            config_file = _absolute_path(voice.config_file)
            if Path(config_file).exists():
                cmd_list.extend(["-c", config_file])
        if use_cuda:
            cmd_list.append("--cuda")
        if debug:
            log_debug(f"Running Piper with args: {cmd_list}")

        subprocess.run(
            cmd_list,
            input=text.encode("utf-8"),
            capture_output=True,
            check=True,
            shell=False,
        )

        with wave.open(output_wav_path, "rb") as wav_file:
            if wav_file.getnchannels() != 1 or wav_file.getsampwidth() != 2:
                raise TTSProviderError("invalid_audio", "Piper produced unsupported audio")
            sample_rate = wav_file.getframerate()
            audio = wav_file.readframes(wav_file.getnframes())
        return audio, sample_rate
    except FileNotFoundError as exc:
        raise TTSProviderError("unavailable", "Piper executable is unavailable") from exc
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr.decode("utf-8", errors="replace").strip()
        if stderr:
            log_warning("Piper synthesis failed; stderr was redacted from provider error")
            log_debug(f"Redacted Piper stderr length={len(stderr)}")
        raise TTSProviderError("unavailable", "Piper synthesis failed") from exc
    finally:
        if os.path.isfile(output_wav_path):
            os.remove(output_wav_path)


class PiperTTSProvider:
    """Provider wrapper for Piper CLI synthesis."""

    provider_id = "piper"

    def __init__(
        self,
        *,
        piper_path: str,
        voice: PiperVoiceConfig,
        use_cuda: bool = False,
        debug: bool = False,
    ) -> None:
        self._piper_path = piper_path
        self._voice = voice
        self._use_cuda = use_cuda
        self._debug = debug
        self._started = False
        self._stopping = False
        self._queued_requests: set[str] = set()
        self._active_requests: set[str] = set()
        self._cancelled_requests: set[str] = set()
        self._state_lock = asyncio.Lock()
        self._execution_lock = asyncio.Lock()

    @property
    def capabilities(self) -> TTSProviderCapabilities:
        """Return Piper's conservative voice-selection capabilities."""
        return TTSProviderCapabilities(
            provider_id=self.provider_id,
            voice_selection_mode=VoiceSelectionMode.ACTIVE_ONLY,
            max_resident_base_models=1,
            supports_inflight_cancel=False,
        )

    @property
    def base_identity(self) -> str:
        """Return the single resident base identity for this Piper voice."""
        return _piper_base_identity(self._voice)

    async def start(self) -> None:
        """Mark the provider ready after validating the active voice path."""
        if not Path(self._voice.model_file).exists():
            raise TTSProviderError("unavailable", "Piper voice model is unavailable")
        async with self._state_lock:
            self._started = True
            self._stopping = False

    async def stop(self) -> None:
        """Stop accepting work, cancel tracked work, and drain active synthesis."""
        async with self._state_lock:
            self._started = False
            self._stopping = True
            self._cancelled_requests.update(self._queued_requests)
            self._cancelled_requests.update(self._active_requests)
        async with self._execution_lock:
            pass
        async with self._state_lock:
            self._queued_requests.clear()
            self._active_requests.clear()
            self._cancelled_requests.clear()
            self._stopping = False

    async def health(self) -> TTSProviderHealth:
        """Return readiness for the active Piper voice."""
        async with self._state_lock:
            ready = self._started and Path(self._voice.model_file).exists()
        return TTSProviderHealth(
            provider_id=self.provider_id,
            ready=ready,
            active_voice=self._voice.voice_id,
            base_identity=self.base_identity if ready else None,
            error=None if ready else "unavailable",
        )

    async def list_voices(self) -> tuple[TTSVoiceInfo, ...]:
        """Return the active Piper voice only."""
        async with self._state_lock:
            ready = self._started and Path(self._voice.model_file).exists()
        return (
            TTSVoiceInfo(
                voice_id=self._voice.voice_id,
                display_name=self._voice.display_name,
                ready=ready,
            ),
        )

    async def cancel(self, request_id: str) -> None:
        """Record cancellation only for known queued or active work."""
        async with self._state_lock:
            if request_id in self._queued_requests or request_id in self._active_requests:
                self._cancelled_requests.add(request_id)

    async def _reject_if_cancelled(self, request_id: str | None) -> None:
        if request_id is None:
            return
        async with self._state_lock:
            if request_id in self._cancelled_requests:
                raise TTSProviderError("cancelled", "TTS request was cancelled")

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

    async def tracked_request_count(self) -> int:
        """Return tracked request state count for lifecycle tests."""
        async with self._state_lock:
            return (
                len(self._queued_requests)
                + len(self._active_requests)
                + len(self._cancelled_requests)
            )

    def _resolve_voice(self, voice: str | None) -> None:
        if voice is not None and voice != self._voice.voice_id:
            raise TTSProviderError("unsupported_voice", "Requested voice is unavailable")

    async def synthesize(self, request: TTSSynthesisRequest) -> TTSSynthesisResult:
        """Synthesize finite audio through Piper without blocking the event loop."""
        if not self._started:
            raise TTSProviderError("unavailable", "TTS provider is unavailable")
        self._resolve_voice(request.voice)
        await self._register_request(request.request_id)
        try:
            await self._reject_if_cancelled(request.request_id)
            async with self._execution_lock:
                await self._activate_request(request.request_id)
                await self._reject_if_cancelled(request.request_id)
                audio, sample_rate = await asyncio.to_thread(
                    synthesize_piper_cli,
                    piper_path=self._piper_path,
                    voice=self._voice,
                    text=request.text,
                    use_cuda=self._use_cuda,
                    debug=self._debug,
                )
                await self._reject_if_cancelled(request.request_id)
            output = (
                pcm_to_wav_bytes(audio, sample_rate=sample_rate)
                if request.audio_format == "wav"
                else audio
            )
            duration_ms = (len(audio) / (sample_rate * 2)) * 1000
            return TTSSynthesisResult(
                audio=output,
                audio_format=request.audio_format,
                sample_rate=sample_rate,
                channels=1,
                duration_ms=duration_ms,
                voice=self._voice.voice_id,
            )
        finally:
            await self._cleanup_request(request.request_id)

    async def stream(self, request: TTSSynthesisRequest) -> AsyncIterator[TTSStreamChunk]:
        """Stream Piper output as one synthesized chunk plus a terminal marker."""
        result = await self.synthesize(request)
        yield TTSStreamChunk(
            sequence=0,
            audio=result.audio,
            sample_rate=result.sample_rate,
            channels=result.channels,
            duration_ms=result.duration_ms,
        )
        yield TTSStreamChunk(
            sequence=1,
            audio=b"",
            sample_rate=result.sample_rate,
            channels=result.channels,
            is_final=True,
        )
