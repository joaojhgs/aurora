from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
SPIKE = ROOT / "tools" / "voice-runtime" / "android-audio-spike"
RUST_LIB = SPIKE / "native" / "src" / "lib.rs"
KOTLIN = (
    SPIKE
    / "android"
    / "app"
    / "src"
    / "main"
    / "java"
    / "dev"
    / "aurora"
    / "voice"
    / "audiospike"
    / "AndroidAudioSpike.kt"
)
CMAKE = SPIKE / "android" / "app" / "src" / "main" / "cpp" / "CMakeLists.txt"
GRADLE_APP = SPIKE / "android" / "app" / "build.gradle.kts"
MANIFEST = SPIKE / "android" / "app" / "src" / "main" / "AndroidManifest.xml"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_android_audio_spike_uses_kotlin_audiorecord_into_native_bridge() -> None:
    source = read(KOTLIN)

    assert "AudioRecord.Builder()" in source
    assert "AudioManager" in source
    assert "VOICE_RECOGNITION" in source
    assert "READ_BLOCKING" in source
    assert "buffer.copyOf(read)" in source
    assert "bridge.pushPcm(chunk, read, sequence++)" in source
    assert "running.set(false)" in source
    assert "worker.quitSafely()" in source


def test_android_audio_spike_does_not_log_raw_audio() -> None:
    source = read(KOTLIN)

    assert "Log.i" in source
    forbidden_patterns = [
        r"Log\.[a-z]+\([^)]*chunk",
        r"Log\.[a-z]+\([^)]*buffer",
        r"contentToString",
        r"joinToString",
    ]
    for pattern in forbidden_patterns:
        assert not re.search(pattern, source, flags=re.DOTALL), pattern


def test_rust_state_owns_bounded_backpressure_and_shutdown() -> None:
    source = read(RUST_LIB)

    assert "VecDeque<PcmChunk>" in source
    assert "MAX_CAPACITY_CHUNKS" in source
    assert "AURORA_AUDIO_BACKPRESSURE" in source
    assert "AURORA_AUDIO_CLOSED" in source
    assert "discontinuities += 1" in source
    assert "inner.queue.clear()" in source
    assert "#[no_mangle]" in source
    assert "aurora_audio_state_push_pcm_i16" in source


def test_android_build_imports_rust_static_library_per_abi() -> None:
    source = read(CMAKE)
    gradle_source = read(GRADLE_APP)

    assert "arm64-v8a" in source
    assert "aarch64-linux-android" in source
    assert "x86_64-linux-android" in source
    assert "libaurora_android_audio_spike.a" in source
    assert "add_library(aurora_android_audio_spike STATIC IMPORTED)" in source
    assert 'abiFilters += listOf("arm64-v8a", "x86_64")' in gradle_source


def test_manifest_declares_microphone_permission() -> None:
    source = read(MANIFEST)

    assert "android.permission.RECORD_AUDIO" in source
    assert "dev.aurora.voice.audiospike" not in source


def test_scripts_fail_closed_without_android_environment() -> None:
    env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": os.environ.get("HOME", ""),
    }
    result = subprocess.run(
        [str(SPIKE / "scripts" / "build-rust-android.sh")],
        cwd=SPIKE,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 2
    assert "Set ANDROID_NDK_HOME" in result.stderr


def test_spike_sources_do_not_commit_machine_absolute_paths() -> None:
    offenders: list[Path] = []
    for path in SPIKE.rglob("*"):
        generated_parts = {".cxx", ".gradle", ".kotlin", "build", "target", "out"}
        if not path.is_file() or generated_parts.intersection(path.parts):
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        if "/home/developer" in text or "/Users/" in text:
            offenders.append(path.relative_to(ROOT))

    assert offenders == []


@pytest.mark.parametrize(
    "script",
    [
        SPIKE / "scripts" / "build-rust-android.sh",
        SPIKE / "scripts" / "build-android.sh",
        SPIKE / "scripts" / "run-emulator-smoke.sh",
    ],
)
def test_scripts_are_executable(script: Path) -> None:
    assert os.access(script, os.X_OK), script
