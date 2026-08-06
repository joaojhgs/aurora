"""Bounded media normalization for voice-profile audio prompts."""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import math
import os
import shutil
import signal
import tempfile
import wave
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, TypeVar

import numpy as np

MediaImportErrorCode = Literal[
    "audio_track_count",
    "clipping",
    "duration_out_of_range",
    "invalid_media",
    "processing_timeout",
    "selection_required",
    "silence",
    "source_too_large",
    "unavailable",
    "unsupported_media",
]

_T = TypeVar("_T")


class _OutputLimitError(RuntimeError):
    """Internal sentinel raised before subprocess output can grow unbounded."""


class MediaImportError(RuntimeError):
    """Sanitized media-import failure suitable for a product-facing mapper."""

    def __init__(self, code: MediaImportErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class MediaSelection:
    """A bounded source region selected for voice-profile creation."""

    start_s: float
    duration_s: float


@dataclass(frozen=True)
class MediaImportPolicy:
    """Limits and signal-quality checks for imported audio."""

    max_source_bytes: int = 20 * 1024 * 1024
    min_duration_s: float = 6.0
    max_duration_s: float = 15.0
    sample_rate: int = 24_000
    timeout_s: float = 20.0
    silence_rms_threshold: float = 0.002
    clipped_sample_threshold: float = 0.999
    max_clipped_fraction: float = 0.005
    frame_duration_ms: int = 20
    trim_padding_ms: int = 100
    accepted_formats: tuple[str, ...] = ("wav", "mp3", "mp4", "m4a", "webm")
    accepted_codecs: tuple[str, ...] = (
        "aac",
        "flac",
        "mp3",
        "opus",
        "pcm_f32le",
        "pcm_f64le",
        "pcm_s16le",
        "pcm_s24le",
        "pcm_s32le",
        "vorbis",
    )

    def __post_init__(self) -> None:
        if self.max_source_bytes <= 0:
            raise ValueError("max_source_bytes must be positive")
        if not 0 < self.min_duration_s <= self.max_duration_s:
            raise ValueError("duration bounds must be positive and ordered")
        if self.sample_rate <= 0 or self.timeout_s <= 0:
            raise ValueError("sample_rate and timeout_s must be positive")
        if self.frame_duration_ms <= 0 or self.trim_padding_ms < 0:
            raise ValueError("frame duration must be positive and trim padding non-negative")
        if not 0 < self.silence_rms_threshold < 1:
            raise ValueError("silence_rms_threshold must be between zero and one")
        if not 0 < self.clipped_sample_threshold <= 1:
            raise ValueError("clipped_sample_threshold must be between zero and one")
        if not 0 <= self.max_clipped_fraction <= 1:
            raise ValueError("max_clipped_fraction must be between zero and one")


@dataclass(frozen=True)
class MediaImportResult:
    """Canonical audio and non-sensitive metadata produced by an import."""

    wav_bytes: bytes
    sha256: str
    duration_s: float
    sample_rate: int
    channels: int
    container: str
    source_codec: str
    source_duration_s: float


@dataclass(frozen=True)
class _ProbeResult:
    container: str
    codec: str
    duration_s: float


class MediaImporter:
    """Inspect and normalize voice audio without trusting names or extensions."""

    _PROBE_OUTPUT_LIMIT = 256 * 1024

    def __init__(
        self,
        *,
        policy: MediaImportPolicy | None = None,
        ffmpeg_path: str | None = None,
        ffprobe_path: str | None = None,
        temp_root: Path | None = None,
    ) -> None:
        self.policy = policy or MediaImportPolicy()
        self._ffmpeg_path = self._resolve_tool(ffmpeg_path, "ffmpeg")
        self._ffprobe_path = self._resolve_tool(ffprobe_path, "ffprobe")
        self._temp_root = temp_root

    async def import_bytes(
        self,
        source: bytes,
        *,
        declared_mime: str | None = None,
        source_name: str | None = None,
        selection: MediaSelection | None = None,
    ) -> MediaImportResult:
        """Normalize an imported media object to deterministic mono 24 kHz WAV.

        The optional source name is deliberately ignored for parsing and command
        construction. FFprobe identifies the container and streams from bytes.

        Args:
            source: Complete bounded source object.
            declared_mime: Optional caller-declared media type to compare with probed content.
            source_name: Untrusted display-only name supplied by the caller.
            selection: Optional bounded region for a source longer than the limit.

        Returns:
            Canonical PCM/WAV bytes and safe metadata.

        Raises:
            MediaImportError: If the media, selection, limits, or signal are invalid.
            asyncio.CancelledError: If the caller cancels the import.
        """

        del source_name
        if not isinstance(source, bytes) or not source:
            raise MediaImportError("invalid_media", "The selected audio could not be read.")
        if len(source) > self.policy.max_source_bytes:
            raise MediaImportError("source_too_large", "Choose a smaller audio file.")

        temp_path = Path(tempfile.mkdtemp(prefix="aurora-voice-import-", dir=self._temp_root))
        try:
            source_path = temp_path / "source.bin"
            await self._run_blocking(source_path.write_bytes, source)
            probe = await self._probe(source_path)
            self._validate_declared_mime(declared_mime, probe.container)
            selected_duration = self._validate_selection(probe.duration_s, selection)
            pcm = await self._decode(source_path, selection, selected_duration)
            wav_bytes, duration_s = await self._run_blocking(self._normalize_pcm, pcm)
            return MediaImportResult(
                wav_bytes=wav_bytes,
                sha256=hashlib.sha256(wav_bytes).hexdigest(),
                duration_s=duration_s,
                sample_rate=self.policy.sample_rate,
                channels=1,
                container=probe.container,
                source_codec=probe.codec,
                source_duration_s=probe.duration_s,
            )
        finally:
            await self._cleanup(temp_path)

    async def _probe(self, source_path: Path) -> _ProbeResult:
        output = await self._run_process(
            [
                self._ffprobe_path,
                "-v",
                "error",
                "-show_entries",
                "format=format_name,duration:stream=index,codec_type,codec_name,duration",
                "-of",
                "json",
                str(source_path),
            ],
            output_limit=self._PROBE_OUTPUT_LIMIT,
        )
        try:
            document = json.loads(output)
            streams = document["streams"]
            format_data = document["format"]
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise MediaImportError(
                "invalid_media", "The selected audio could not be read."
            ) from exc

        audio_streams = [stream for stream in streams if stream.get("codec_type") == "audio"]
        if len(audio_streams) != 1:
            raise MediaImportError(
                "audio_track_count", "Choose a file containing exactly one audio track."
            )

        container = self._canonical_container(str(format_data.get("format_name", "")))
        codec = str(audio_streams[0].get("codec_name", "")).strip().lower()
        if not container or not self._format_is_accepted(container):
            raise MediaImportError("unsupported_media", "Choose a supported audio file.")
        if codec not in self.policy.accepted_codecs:
            raise MediaImportError("unsupported_media", "Choose a supported audio file.")

        duration_s = self._read_duration(audio_streams[0], format_data)
        if duration_s is None or not math.isfinite(duration_s) or duration_s <= 0:
            raise MediaImportError("invalid_media", "The selected audio could not be read.")
        return _ProbeResult(container=container, codec=codec, duration_s=duration_s)

    def _validate_selection(
        self,
        source_duration_s: float,
        selection: MediaSelection | None,
    ) -> float:
        if selection is None:
            if source_duration_s > self.policy.max_duration_s + 0.01:
                raise MediaImportError(
                    "selection_required",
                    "Select a shorter section before continuing.",
                )
            if source_duration_s < self.policy.min_duration_s - 0.01:
                raise MediaImportError(
                    "duration_out_of_range",
                    "Choose a longer audio sample.",
                )
            return source_duration_s

        if not math.isfinite(selection.start_s) or not math.isfinite(selection.duration_s):
            raise MediaImportError("duration_out_of_range", "Choose a valid audio section.")
        if selection.start_s < 0:
            raise MediaImportError("duration_out_of_range", "Choose a valid audio section.")
        if not self.policy.min_duration_s <= selection.duration_s <= self.policy.max_duration_s:
            raise MediaImportError(
                "duration_out_of_range",
                "Choose an audio section within the allowed length.",
            )
        if selection.start_s + selection.duration_s > source_duration_s + 0.01:
            raise MediaImportError("duration_out_of_range", "Choose a valid audio section.")
        return selection.duration_s

    async def _decode(
        self,
        source_path: Path,
        selection: MediaSelection | None,
        selected_duration_s: float,
    ) -> bytes:
        command = [
            self._ffmpeg_path,
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-i",
            str(source_path),
        ]
        if selection is not None:
            command.extend(["-ss", self._decimal(selection.start_s)])
            command.extend(["-t", self._decimal(selection.duration_s)])
        command.extend(
            [
                "-map",
                "0:a:0",
                "-vn",
                "-ac",
                "1",
                "-ar",
                str(self.policy.sample_rate),
                "-acodec",
                "pcm_f32le",
                "-f",
                "f32le",
                "pipe:1",
            ]
        )
        output_limit = math.ceil((selected_duration_s + 1.0) * self.policy.sample_rate * 4)
        return await self._run_process(command, output_limit=output_limit)

    async def _run_process(self, argv: list[str], *, output_limit: int) -> bytes:
        try:
            process = await asyncio.create_subprocess_exec(
                *argv,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
        except OSError as exc:
            raise MediaImportError(
                "unavailable", "Audio import is unavailable on this device."
            ) from exc

        communication_task = asyncio.create_task(
            self._collect_process_output(process, output_limit=output_limit)
        )
        try:
            stdout = await asyncio.wait_for(
                communication_task,
                timeout=self.policy.timeout_s,
            )
        except asyncio.CancelledError:
            await self._terminate_process(process)
            raise
        except TimeoutError as exc:
            await self._terminate_process(process)
            raise MediaImportError("processing_timeout", "Audio processing took too long.") from exc
        except _OutputLimitError as exc:
            await self._terminate_process(process)
            raise MediaImportError(
                "invalid_media", "The selected audio could not be read."
            ) from exc

        if process.returncode != 0:
            raise MediaImportError("invalid_media", "The selected audio could not be read.")
        return stdout

    async def _collect_process_output(
        self,
        process: asyncio.subprocess.Process,
        *,
        output_limit: int,
    ) -> bytes:
        if process.stdout is None or process.stderr is None:
            raise MediaImportError("invalid_media", "The selected audio could not be read.")
        stdout, _ = await asyncio.gather(
            self._read_bounded(process.stdout, output_limit),
            self._drain_stream(process.stderr),
        )
        await process.wait()
        return stdout

    async def _read_bounded(
        self,
        stream: asyncio.StreamReader,
        limit: int,
    ) -> bytes:
        chunks: list[bytes] = []
        total = 0
        exceeded = False
        while chunk := await stream.read(64 * 1024):
            total += len(chunk)
            if total > limit:
                exceeded = True
            elif not exceeded:
                chunks.append(chunk)
        if exceeded:
            raise _OutputLimitError
        return b"".join(chunks)

    async def _drain_stream(self, stream: asyncio.StreamReader) -> None:
        while await stream.read(64 * 1024):
            pass

    async def _terminate_process(self, process: asyncio.subprocess.Process) -> None:
        if process.returncode is None:
            try:
                if os.name == "posix":
                    os.killpg(process.pid, signal.SIGKILL)
                else:
                    process.kill()
            except ProcessLookupError:
                pass
            except OSError:
                process.kill()
        wait_task = asyncio.create_task(process.communicate())
        try:
            await asyncio.shield(wait_task)
        except asyncio.CancelledError:
            await wait_task

    async def _cleanup(self, temp_path: Path) -> None:
        cleanup_task = asyncio.create_task(
            asyncio.to_thread(shutil.rmtree, temp_path, ignore_errors=True)
        )
        try:
            await asyncio.shield(cleanup_task)
        except asyncio.CancelledError:
            await cleanup_task

    async def _run_blocking(self, operation: Callable[..., _T], *args: Any) -> _T:
        task = asyncio.create_task(asyncio.to_thread(operation, *args))
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            await task
            raise

    def _normalize_pcm(self, pcm: bytes) -> tuple[bytes, float]:
        if not pcm or len(pcm) % 4:
            raise MediaImportError("invalid_media", "The selected audio could not be read.")
        samples = np.frombuffer(pcm, dtype="<f4").astype(np.float64)
        if samples.size == 0 or not np.isfinite(samples).all():
            raise MediaImportError("invalid_media", "The selected audio could not be read.")

        clipped_fraction = float(
            np.count_nonzero(np.abs(samples) >= self.policy.clipped_sample_threshold)
        ) / float(samples.size)
        if clipped_fraction > self.policy.max_clipped_fraction:
            raise MediaImportError("clipping", "Choose a recording without distorted peaks.")

        samples = self._trim_to_activity(samples)
        samples -= float(np.mean(samples))
        samples = self._trim_to_activity(samples)
        rms = float(np.sqrt(np.mean(np.square(samples))))
        if not math.isfinite(rms) or rms < self.policy.silence_rms_threshold:
            raise MediaImportError("silence", "Choose a recording with clear speech.")

        duration_s = float(samples.size) / float(self.policy.sample_rate)
        if not self.policy.min_duration_s <= duration_s <= self.policy.max_duration_s:
            raise MediaImportError(
                "duration_out_of_range",
                "Choose a recording within the allowed length.",
            )

        integer_samples = np.rint(np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2")
        output = io.BytesIO()
        with wave.open(output, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(self.policy.sample_rate)
            wav_file.writeframes(integer_samples.tobytes())
        return output.getvalue(), duration_s

    def _trim_to_activity(self, samples: np.ndarray[Any, np.dtype[np.float64]]) -> np.ndarray:
        frame_size = max(1, round(self.policy.sample_rate * self.policy.frame_duration_ms / 1000))
        frame_count = math.ceil(samples.size / frame_size)
        padded = np.pad(samples, (0, frame_count * frame_size - samples.size))
        frames = padded.reshape(frame_count, frame_size)
        frame_rms = np.sqrt(np.mean(np.square(frames), axis=1))
        active = np.flatnonzero(frame_rms >= self.policy.silence_rms_threshold)
        if active.size == 0:
            raise MediaImportError("silence", "Choose a recording with clear speech.")

        padding_frames = math.ceil(self.policy.trim_padding_ms / self.policy.frame_duration_ms)
        first_frame = max(0, int(active[0]) - padding_frames)
        last_frame = min(frame_count, int(active[-1]) + padding_frames + 1)
        start = first_frame * frame_size
        end = min(samples.size, last_frame * frame_size)
        return samples[start:end].copy()

    def _canonical_container(self, raw_names: str) -> str | None:
        names = {name.strip().lower() for name in raw_names.split(",") if name.strip()}
        if "wav" in names:
            return "wav"
        if "mp3" in names:
            return "mp3"
        if names.intersection({"mov", "mp4", "m4a", "3gp", "3g2", "mj2"}):
            return "mp4"
        if names.intersection({"matroska", "webm"}):
            return "webm"
        return None

    def _format_is_accepted(self, container: str) -> bool:
        accepted = set(self.policy.accepted_formats)
        if container == "mp4":
            return bool(accepted.intersection({"mp4", "m4a"}))
        return container in accepted

    def _validate_declared_mime(self, declared_mime: str | None, container: str) -> None:
        if declared_mime is None:
            return
        normalized = declared_mime.split(";", 1)[0].strip().lower()
        expected_container = {
            "audio/aac": "mp4",
            "audio/mp4": "mp4",
            "audio/mpeg": "mp3",
            "audio/mp3": "mp3",
            "audio/wav": "wav",
            "audio/wave": "wav",
            "audio/webm": "webm",
            "audio/x-m4a": "mp4",
            "audio/x-wav": "wav",
            "video/mp4": "mp4",
            "video/webm": "webm",
        }.get(normalized)
        if expected_container is None:
            raise MediaImportError("unsupported_media", "Choose a supported audio file.")
        if expected_container != container:
            raise MediaImportError("unsupported_media", "Choose a supported audio file.")

    @staticmethod
    def _read_duration(stream: dict[str, Any], format_data: dict[str, Any]) -> float | None:
        for candidate in (stream.get("duration"), format_data.get("duration")):
            if candidate is None:
                continue
            try:
                return float(candidate)
            except (TypeError, ValueError):
                continue
        return None

    @staticmethod
    def _decimal(value: float) -> str:
        return format(value, ".6f")

    @staticmethod
    def _resolve_tool(explicit_path: str | None, name: str) -> str:
        resolved = explicit_path or shutil.which(name)
        if not resolved:
            raise MediaImportError("unavailable", "Audio import is unavailable on this device.")
        return resolved
