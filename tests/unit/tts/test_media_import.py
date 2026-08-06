from __future__ import annotations

import asyncio
import io
import math
import os
import shutil
import subprocess
import sys
import wave
from array import array
from collections.abc import Callable
from pathlib import Path

import pytest

from app.services.tts.media_import import (
    MediaImporter,
    MediaImportError,
    MediaImportPolicy,
    MediaSelection,
)


def _wav_bytes(
    *,
    active_seconds: float = 6.4,
    leading_silence: float = 0.3,
    trailing_silence: float = 0.3,
    sample_rate: int = 16_000,
    channels: int = 2,
    amplitude: float = 0.2,
    dc_offset: float = 0.04,
) -> bytes:
    frames = array("h")

    def append_frame(value: float) -> None:
        sample = max(-1.0, min(1.0, value))
        integer = int(round(sample * 32767.0))
        frames.extend([integer] * channels)

    for _ in range(round(leading_silence * sample_rate)):
        append_frame(0.0)
    for index in range(round(active_seconds * sample_rate)):
        append_frame(amplitude * math.sin(2.0 * math.pi * 220.0 * index / sample_rate) + dc_offset)
    for _ in range(round(trailing_silence * sample_rate)):
        append_frame(0.0)

    output = io.BytesIO()
    with wave.open(output, "wb") as wav_file:
        wav_file.setnchannels(channels)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(frames.tobytes())
    return output.getvalue()


def _require_ffmpeg() -> tuple[str, str]:
    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        pytest.skip("FFmpeg tools are unavailable")
    assert ffmpeg is not None
    assert ffprobe is not None
    return ffmpeg, ffprobe


def _transcode_audio(
    source: bytes,
    tmp_path: Path,
    *,
    suffix: str,
    codec: str,
    extra_args: list[str] | None = None,
) -> bytes:
    ffmpeg, _ = _require_ffmpeg()
    tmp_path.mkdir(parents=True, exist_ok=True)
    source_path = tmp_path / "source.wav"
    target_path = tmp_path / f"source{suffix}"
    source_path.write_bytes(source)
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-i",
        str(source_path),
        "-map",
        "0:a:0",
        "-c:a",
        codec,
    ]
    if extra_args:
        command.extend(extra_args)
    command.append(str(target_path))
    subprocess.run(
        command,
        check=True,
        capture_output=True,
        timeout=20,
    )
    return target_path.read_bytes()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("case_id", "make_source", "declared_mime", "container", "codec"),
    [
        ("wav", lambda source, path: source, "audio/wav", "wav", "pcm_s16le"),
        (
            "mp3",
            lambda source, path: _transcode_audio(
                source, path, suffix=".mp3", codec="libmp3lame", extra_args=["-b:a", "128k"]
            ),
            "audio/mpeg",
            "mp3",
            "mp3",
        ),
        (
            "m4a",
            lambda source, path: _transcode_audio(
                source, path, suffix=".m4a", codec="aac", extra_args=["-b:a", "128k"]
            ),
            "audio/x-m4a",
            "mp4",
            "aac",
        ),
        (
            "webm",
            lambda source, path: _transcode_audio(
                source, path, suffix=".webm", codec="libopus", extra_args=["-b:a", "96k"]
            ),
            "audio/webm",
            "webm",
            "opus",
        ),
        (
            "aac-in-mp4",
            lambda source, path: _transcode_audio(
                source, path, suffix=".mp4", codec="aac", extra_args=["-b:a", "128k"]
            ),
            "audio/mp4",
            "mp4",
            "aac",
        ),
    ],
    ids=lambda value: value if isinstance(value, str) else None,
)
async def test_supported_imports_are_content_inspected_canonical_and_deterministic(
    tmp_path: Path,
    case_id: str,
    make_source: Callable[[bytes, Path], bytes],
    declared_mime: str,
    container: str,
    codec: str,
) -> None:
    ffmpeg, ffprobe = _require_ffmpeg()
    source = make_source(_wav_bytes(), tmp_path / case_id)
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    importer = MediaImporter(
        ffmpeg_path=ffmpeg,
        ffprobe_path=ffprobe,
        temp_root=scratch,
    )

    marker = tmp_path / "must-not-exist"
    malicious_name = f"voice.$(touch {marker}).wav"
    first = await importer.import_bytes(
        source, declared_mime=declared_mime, source_name=malicious_name
    )
    second = await importer.import_bytes(
        source, declared_mime=declared_mime, source_name="spoofed.wav"
    )

    assert first.container == container
    assert first.source_codec == codec
    assert first.sample_rate == 24_000
    assert first.channels == 1
    assert importer.policy.min_duration_s <= first.duration_s <= importer.policy.max_duration_s
    assert first.source_duration_s >= first.duration_s
    assert first.sha256 == second.sha256
    assert first.wav_bytes == second.wav_bytes
    assert not marker.exists()
    assert list(scratch.iterdir()) == []

    with wave.open(io.BytesIO(first.wav_bytes), "rb") as wav_file:
        assert wav_file.getframerate() == 24_000
        assert wav_file.getnchannels() == 1
        assert wav_file.getsampwidth() == 2


@pytest.mark.asyncio
async def test_long_source_requires_bounded_selection(tmp_path: Path) -> None:
    ffmpeg, ffprobe = _require_ffmpeg()
    importer = MediaImporter(ffmpeg_path=ffmpeg, ffprobe_path=ffprobe, temp_root=tmp_path)
    source = _wav_bytes(active_seconds=16.0, leading_silence=0.0, trailing_silence=0.0)

    with pytest.raises(MediaImportError, match="Select a shorter section") as exc_info:
        await importer.import_bytes(source)
    assert exc_info.value.code == "selection_required"

    result = await importer.import_bytes(
        source,
        selection=MediaSelection(start_s=2.0, duration_s=7.0),
    )
    assert 6.9 <= result.duration_s <= 7.0
    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("source", "expected_code"),
    [
        (b"this is not media", "invalid_media"),
        (_wav_bytes(active_seconds=7.0, amplitude=0.0, dc_offset=0.0), "silence"),
        (_wav_bytes(active_seconds=7.0, amplitude=1.0, dc_offset=0.0), "clipping"),
        (_wav_bytes(active_seconds=2.0), "duration_out_of_range"),
    ],
    ids=("not-media", "silence", "clipping", "too-short"),
)
async def test_invalid_audio_is_rejected_without_temp_leaks(
    tmp_path: Path,
    source: bytes,
    expected_code: str,
) -> None:
    ffmpeg, ffprobe = _require_ffmpeg()
    importer = MediaImporter(ffmpeg_path=ffmpeg, ffprobe_path=ffprobe, temp_root=tmp_path)

    with pytest.raises(MediaImportError) as exc_info:
        await importer.import_bytes(source, source_name="voice.mp4")

    assert exc_info.value.code == expected_code
    assert list(tmp_path.iterdir()) == []
    assert "tmp" not in str(exc_info.value).lower()


@pytest.mark.asyncio
async def test_multiple_audio_tracks_are_rejected(tmp_path: Path) -> None:
    ffmpeg, ffprobe = _require_ffmpeg()
    source_path = tmp_path / "multi.mkv"
    subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=220:duration=7",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=330:duration=7",
            "-map",
            "0:a:0",
            "-map",
            "1:a:0",
            "-c:a",
            "libopus",
            str(source_path),
        ],
        check=True,
        capture_output=True,
        timeout=20,
    )
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    importer = MediaImporter(ffmpeg_path=ffmpeg, ffprobe_path=ffprobe, temp_root=scratch)

    with pytest.raises(MediaImportError) as exc_info:
        await importer.import_bytes(source_path.read_bytes())

    assert exc_info.value.code == "audio_track_count"
    assert list(scratch.iterdir()) == []


@pytest.mark.asyncio
async def test_absent_audio_track_is_rejected_without_temp_leaks(tmp_path: Path) -> None:
    ffmpeg, ffprobe = _require_ffmpeg()
    source_path = tmp_path / "video-only.mp4"
    subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=16x16:d=7",
            "-an",
            "-c:v",
            "mpeg4",
            str(source_path),
        ],
        check=True,
        capture_output=True,
        timeout=20,
    )
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    importer = MediaImporter(ffmpeg_path=ffmpeg, ffprobe_path=ffprobe, temp_root=scratch)

    with pytest.raises(MediaImportError) as exc_info:
        await importer.import_bytes(source_path.read_bytes(), declared_mime="video/mp4")

    assert exc_info.value.code == "audio_track_count"
    assert list(scratch.iterdir()) == []


@pytest.mark.asyncio
async def test_declared_mime_mismatch_is_rejected_after_content_probe(tmp_path: Path) -> None:
    ffmpeg, ffprobe = _require_ffmpeg()
    importer = MediaImporter(ffmpeg_path=ffmpeg, ffprobe_path=ffprobe, temp_root=tmp_path)

    with pytest.raises(MediaImportError) as exc_info:
        await importer.import_bytes(_wav_bytes(), declared_mime="audio/mpeg")

    assert exc_info.value.code == "unsupported_media"
    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
async def test_aac_in_mp4_requires_mp4_or_m4a_mime(tmp_path: Path) -> None:
    ffmpeg, ffprobe = _require_ffmpeg()
    mp4 = _transcode_audio(
        _wav_bytes(),
        tmp_path / "mp4",
        suffix=".mp4",
        codec="aac",
        extra_args=["-b:a", "128k"],
    )
    m4a = _transcode_audio(
        _wav_bytes(),
        tmp_path / "m4a",
        suffix=".m4a",
        codec="aac",
        extra_args=["-b:a", "128k"],
    )
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    importer = MediaImporter(ffmpeg_path=ffmpeg, ffprobe_path=ffprobe, temp_root=scratch)

    mp4_result = await importer.import_bytes(mp4, declared_mime="audio/mp4")
    m4a_result = await importer.import_bytes(m4a, declared_mime="audio/x-m4a")

    assert mp4_result.container == "mp4"
    assert mp4_result.source_codec == "aac"
    assert m4a_result.container == "mp4"
    assert m4a_result.source_codec == "aac"
    with pytest.raises(MediaImportError) as exc_info:
        await importer.import_bytes(mp4, declared_mime="audio/aac")

    assert exc_info.value.code == "unsupported_media"
    assert list(scratch.iterdir()) == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "source",
    [
        lambda path: _transcode_audio(
            _wav_bytes(), path, suffix=".mp3", codec="libmp3lame", extra_args=["-b:a", "128k"]
        )[:128],
        lambda path: _transcode_audio(
            _wav_bytes(), path, suffix=".webm", codec="libopus", extra_args=["-b:a", "96k"]
        )[:256],
    ],
    ids=("truncated-mp3", "truncated-webm"),
)
async def test_truncated_supported_containers_are_rejected_without_temp_leaks(
    tmp_path: Path,
    source: Callable[[Path], bytes],
) -> None:
    ffmpeg, ffprobe = _require_ffmpeg()
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    importer = MediaImporter(ffmpeg_path=ffmpeg, ffprobe_path=ffprobe, temp_root=scratch)

    with pytest.raises(MediaImportError) as exc_info:
        await importer.import_bytes(source(tmp_path / "encoded"))

    assert exc_info.value.code in {"invalid_media", "duration_out_of_range"}
    assert list(scratch.iterdir()) == []


@pytest.mark.asyncio
async def test_small_source_large_decoded_output_is_bounded(tmp_path: Path) -> None:
    ffmpeg, ffprobe = _require_ffmpeg()
    importer = MediaImporter(ffmpeg_path=ffmpeg, ffprobe_path=ffprobe, temp_root=tmp_path)

    with pytest.raises(MediaImportError) as exc_info:
        await importer._run_process(
            [
                sys.executable,
                "-c",
                (
                    "import sys; "
                    "sys.stdout.buffer.write(b'x' * (24000 * 4 * 18)); "
                    "sys.stdout.flush()"
                ),
            ],
            output_limit=math.ceil(8.0 * 24_000 * 4),
        )

    assert exc_info.value.code == "invalid_media"


@pytest.mark.asyncio
async def test_size_limit_and_cancellation_cleanup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ffmpeg, ffprobe = _require_ffmpeg()
    importer = MediaImporter(ffmpeg_path=ffmpeg, ffprobe_path=ffprobe, temp_root=tmp_path)

    with pytest.raises(MediaImportError) as exc_info:
        await importer.import_bytes(b"x" * (importer.policy.max_source_bytes + 1))
    assert exc_info.value.code == "source_too_large"

    entered = asyncio.Event()

    async def never_finishes(argv: list[str], *, output_limit: int) -> bytes:
        del argv, output_limit
        entered.set()
        await asyncio.Future()
        raise AssertionError("unreachable")

    monkeypatch.setattr(importer, "_run_process", never_finishes)
    task = asyncio.create_task(importer.import_bytes(_wav_bytes()))
    await asyncio.wait_for(entered.wait(), timeout=1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
async def test_subprocess_output_is_bounded(tmp_path: Path) -> None:
    ffmpeg, ffprobe = _require_ffmpeg()
    importer = MediaImporter(ffmpeg_path=ffmpeg, ffprobe_path=ffprobe, temp_root=tmp_path)

    with pytest.raises(MediaImportError) as exc_info:
        await importer._run_process(
            [sys.executable, "-c", "import sys; sys.stdout.buffer.write(b'x' * 1000000)"],
            output_limit=1024,
        )

    assert exc_info.value.code == "invalid_media"


@pytest.mark.asyncio
async def test_timeout_terminates_the_subprocess_group(tmp_path: Path) -> None:
    if os.name != "posix":
        pytest.skip("Process-group lifecycle assertion is POSIX-specific")
    ffmpeg, ffprobe = _require_ffmpeg()
    importer = MediaImporter(
        ffmpeg_path=ffmpeg,
        ffprobe_path=ffprobe,
        temp_root=tmp_path,
        policy=MediaImportPolicy(timeout_s=0.2),
    )
    child_pid_path = tmp_path / "child.pid"
    wrapper = (
        "import pathlib, subprocess, sys, time; "
        "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)']); "
        "pathlib.Path(sys.argv[1]).write_text(str(child.pid)); "
        "time.sleep(30)"
    )

    with pytest.raises(MediaImportError) as exc_info:
        await importer._run_process(
            [sys.executable, "-c", wrapper, str(child_pid_path)],
            output_limit=1024,
        )

    assert exc_info.value.code == "processing_timeout"
    child_pid = int(child_pid_path.read_text())
    child_status = Path(f"/proc/{child_pid}/stat")
    for _ in range(100):
        if not child_status.exists():
            break
        if child_status.read_text().split()[2] == "Z":
            break
        await asyncio.sleep(0.02)
    else:
        pytest.fail("media subprocess child survived its parent timeout")
