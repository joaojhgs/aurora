from __future__ import annotations

import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SPIKE = ROOT / "tools" / "voice-runtime" / "ios-audio-spike"
RUST_LIB = SPIKE / "native" / "src" / "lib.rs"
HEADER = SPIKE / "include" / "aurora_ios_audio_bridge.h"
SWIFT = SPIKE / "swift" / "Sources" / "AuroraIOSAudioSpike" / "AuroraIOSAudioSpike.swift"
PACKAGE = SPIKE / "swift" / "Package.swift"
MODULEMAP = SPIKE / "swift" / "Sources" / "CAuroraIOSAudioBridge" / "module.modulemap"
SCRIPT = SPIKE / "scripts" / "build-rust-ios.sh"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_ios_swift_uses_avfoundation_foreground_capture_to_c_abi() -> None:
    source = read(SWIFT)

    assert "import AVFoundation" in source
    assert "import CAuroraIOSAudioBridge" in source
    assert "AVAudioSession" in source
    assert "AVAudioEngine" in source
    assert "setCategory(.playAndRecord, mode: .measurement" in source
    assert "installTap(onBus: 0" in source
    assert "buffer.floatChannelData" in source
    assert "let state = self.state" in source
    assert "aurora_ios_audio_state_push_pcm_f32" in source
    assert "aurora_ios_audio_state_drain_one" in source
    assert "removeTap(onBus: 0)" in source
    assert "setActive(false" in source


def test_ios_swift_package_models_c_abi_as_system_library() -> None:
    package = read(PACKAGE)
    modulemap = read(MODULEMAP)

    assert 'dependencies: ["CAuroraIOSAudioBridge"]' in package
    assert ".systemLibrary(" in package
    assert 'name: "CAuroraIOSAudioBridge"' in package
    assert "aurora_ios_audio_bridge.h" in modulemap
    assert 'link "aurora_ios_audio_spike"' in modulemap


def test_ios_swift_does_not_log_raw_audio_or_use_background_capture() -> None:
    source = read(SWIFT)

    forbidden = [
        "print(",
        "NSLog",
        "os_log",
        "AVAudioSession.CategoryOptions.mixWithOthers",
        "beginBackgroundTask",
        "UIBackgroundModes",
        "Data(bytes:",
    ]
    for item in forbidden:
        assert item not in source


def test_ios_c_header_exposes_narrow_null_safe_runtime_boundary() -> None:
    source = read(HEADER)

    assert "typedef struct AuroraIosAudioState AuroraIosAudioState;" in source
    assert "aurora_ios_audio_state_new" in source
    assert "aurora_ios_audio_state_push_pcm_f32" in source
    assert "const float *samples" in source
    assert "uint64_t sequence" in source
    assert "uint32_t sample_rate_hz" in source
    assert "aurora_ios_audio_state_close" in source
    assert "AuroraIosAudioStats" in source


def test_ios_rust_state_owns_bounded_queue_shutdown_and_backpressure() -> None:
    source = read(RUST_LIB)
    cargo_toml = read(SPIKE / "native" / "Cargo.toml")
    toolchain = read(SPIKE / "rust-toolchain.toml")

    assert "VecDeque<PcmChunk>" in source
    assert "MAX_CAPACITY_CHUNKS" in source
    assert "AURORA_IOS_AUDIO_BACKPRESSURE" in source
    assert "AURORA_IOS_AUDIO_CLOSED" in source
    assert "samples.iter().any(|sample| !sample.is_finite())" in source
    assert "inner.queue.clear()" in source
    assert "discontinuities += 1" in source
    assert "#[no_mangle]" in source
    assert "aurora_ios_audio_state_push_pcm_f32" in source
    assert 'rust-version = "1.88.0"' in cargo_toml
    assert 'channel = "1.88.0"' in toolchain


def test_ios_spike_scripts_fail_closed_on_non_macos() -> None:
    result = subprocess.run(
        [str(SCRIPT)],
        cwd=SPIKE,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 2
    assert "iOS builds require a macOS runner with Xcode" in result.stderr


def test_ios_spike_sources_do_not_commit_machine_absolute_paths() -> None:
    offenders: list[Path] = []
    for path in SPIKE.rglob("*"):
        generated_parts = {"target", "build", ".build", "DerivedData"}
        if not path.is_file() or generated_parts.intersection(path.parts):
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        if "/home/developer" in text or "/Users/" in text:
            offenders.append(path.relative_to(ROOT))

    assert offenders == []


def test_ios_build_script_is_executable() -> None:
    assert os.access(SCRIPT, os.X_OK)
