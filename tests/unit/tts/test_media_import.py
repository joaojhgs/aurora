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
    return ffmpeg, ffprobe


def _to_mp4(source: bytes, tmp_path: Path) -> bytes:
    ffmpeg, _ = _require_ffmpeg()
    source_path = tmp_path / "source.wav"
    target_path = tmp_path / "source.mp4"
    source_path.write_bytes(source)
    subprocess.run(
        [
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
            "aac",
            "-b:a",
            "128k",
            str(target_path),
        ],
        check=True,
        capture_output=True,
        timeout=20,
    )
    return target_path.read_bytes()


@pytest.mark.asyncio
async def test_mp4_import_is_content_inspected_and_deterministic(tmp_path: Path) -> None:
    ffmpeg, ffprobe = _require_ffmpeg()
    mp4 = _to_mp4(_wav_bytes(), tmp_path)
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    importer = MediaImporter(
        ffmpeg_path=ffmpeg,
        ffprobe_path=ffprobe,
        temp_root=scratch,
    )

    marker = tmp_path / "must-not-exist"
    malicious_name = f"voice.$(touch {marker}).wav"
    first = await importer.import_bytes(mp4, source_name=malicious_name)
    second = await importer.import_bytes(mp4, source_name="spoofed.wav")

    assert first.container == "mp4"
    assert first.source_codec == "aac"
    assert first.sample_rate == 24_000
    assert first.channels == 1
    assert 6.0 <= first.duration_s <= 6.7
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
async def test_size_limit_and_cancellation_cleanup(tmp_path: Path) -> None:
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

    importer._run_process = never_finishes  # type: ignore[method-assign]
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
