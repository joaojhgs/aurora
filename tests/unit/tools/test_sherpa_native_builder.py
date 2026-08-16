from __future__ import annotations

import importlib.util
import io
import json
import sys
import zipfile
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

REPO = Path(__file__).resolve().parents[3]
SCRIPT = REPO / "tools/voice-runtime/build_sherpa_native.py"


def load_builder() -> ModuleType:
    spec = importlib.util.spec_from_file_location("build_sherpa_native", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def write_installed_static_libraries(
    builder: ModuleType,
    plan: Any,
    artifact_root: Path,
    *,
    omit: frozenset[str] = frozenset(),
) -> Path:
    install = artifact_root / "build/install"
    lib_dir = install / "lib"
    lib_dir.mkdir(parents=True)
    for library in builder.STATIC_LIBRARIES:
        if library in omit:
            continue
        filename = builder.static_library_filename(library, plan.target)
        (lib_dir / filename).write_bytes(f"archive:{library}".encode())
    return install


def test_host_target_resolution_is_explicit() -> None:
    builder = load_builder()

    linux = builder.resolve_target("host", "Linux", "x86_64")
    macos = builder.resolve_target("host", "Darwin", "arm64")
    windows = builder.resolve_target("host", "Windows", "AMD64")

    assert linux.target == "x86_64-unknown-linux-gnu"
    assert macos.target == "aarch64-apple-darwin"
    assert windows.target == "x86_64-pc-windows-msvc"
    with pytest.raises(builder.NativeBuildError, match="unsupported native Sherpa host"):
        builder.resolve_target("host", "Linux", "riscv64")


def test_ios_configuration_uses_pinned_static_slice(tmp_path: Path) -> None:
    builder = load_builder()
    plan = builder.TARGETS["aarch64-apple-ios-sim"]
    artifact_root = tmp_path / "artifacts"
    source = artifact_root / "sources/extracted/sherpa-onnx-1.13.5"
    command = builder.configure_command(
        plan,
        artifact_root,
        source,
        artifact_root / "build",
        artifact_root / "install",
    )

    assert command[:2] == [builder.sys.executable, str(builder.SCRIPT_DIR / "run_sherpa_cmake.py")]
    assert "--allow-aurora-pockettts-patches" in command
    assert "-DBUILD_SHARED_LIBS=OFF" in command
    assert "-DSHERPA_ONNX_ENABLE_TTS=ON" in command
    assert "-DPLATFORM=SIMULATORARM64" in command
    assert "-DSHERPA_ONNX_USE_PRE_INSTALLED_ONNXRUNTIME_IF_AVAILABLE=ON" in command
    assert plan.ort_pin[1] == ("9a0316f4335017a31edd91250881594876fe5fc0805f7490a304b163de6e0817")


def test_desktop_configuration_forces_verified_static_onnxruntime(tmp_path: Path) -> None:
    builder = load_builder()
    expected_hashes = {
        "x86_64-unknown-linux-gnu": (
            "6b4df7fc46d3367b6be73fdea80dee323b9dc9eaa8dc50136a33d8524e7f06bb"
        ),
        "aarch64-apple-darwin": (
            "b9a84d5d1770818a8bb2a12d9adb45fc2cf5062b930176914cd4e7150ce3fcd2"
        ),
        "x86_64-pc-windows-msvc": (
            "de11b05b1f42476c612e13eb2ed8f6f30d8c486d56dfab29906a947e6b3abfcf"
        ),
    }
    for target, expected_hash in expected_hashes.items():
        plan = builder.TARGETS[target]
        artifact_root = tmp_path / target
        source = artifact_root / "sources/extracted/sherpa-onnx-1.13.5"
        command = builder.configure_command(
            plan,
            artifact_root,
            source,
            artifact_root / "build",
            artifact_root / "install",
        )
        assert "-DBUILD_SHARED_LIBS=OFF" in command
        assert "-DSHERPA_ONNX_USE_PRE_INSTALLED_ONNXRUNTIME_IF_AVAILABLE=OFF" in command
        assert plan.ort_pin[0].startswith(builder.ORT_RELEASE_ROOT)
        assert plan.ort_pin[1] == expected_hash


def test_zip_extraction_rejects_parent_escape(tmp_path: Path) -> None:
    builder = load_builder()
    archive = tmp_path / "unsafe.zip"
    with zipfile.ZipFile(archive, "w") as output:
        output.writestr("../escape", b"bad")

    with pytest.raises(builder.NativeBuildError, match="unsafe ZIP member"):
        builder.safe_extract_zip(archive, tmp_path / "out")


def test_static_runtime_staging_requires_complete_link_set(tmp_path: Path) -> None:
    builder = load_builder()
    plan = builder.TARGETS["x86_64-unknown-linux-gnu"]
    artifact_root = tmp_path / "artifacts"
    install = write_installed_static_libraries(builder, plan, artifact_root)
    lib_dir = install / "lib"

    output = artifact_root / "runtime" / plan.target
    builder.stage_runtime(plan, artifact_root, install, output, None)

    metadata = json.loads((output / "aurora-sherpa-runtime.json").read_text())
    assert metadata["target"] == plan.target
    assert metadata["link_kind"] == "static"
    assert metadata["static_libraries"] == list(builder.STATIC_LIBRARIES)
    assert sorted(path.name for path in output.glob("*.a")) == sorted(
        builder.static_library_filename(name, plan.target) for name in builder.STATIC_LIBRARIES
    )

    (lib_dir / "libonnxruntime.a").unlink()
    with pytest.raises(builder.NativeBuildError, match="missing"):
        builder.stage_runtime(
            plan,
            artifact_root,
            install,
            artifact_root / "runtime/incomplete",
            None,
        )


def test_ios_runtime_thins_fat_onnxruntime_to_static_archive(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    builder = load_builder()
    plan = builder.TARGETS["aarch64-apple-ios-sim"]
    artifact_root = tmp_path / "artifacts"
    install = write_installed_static_libraries(
        builder,
        plan,
        artifact_root,
        omit=frozenset({"onnxruntime"}),
    )
    ort_binary = artifact_root / "xcframework/onnxruntime.framework/onnxruntime"
    ort_binary.parent.mkdir(parents=True)
    ort_binary.write_bytes(b"fat static framework")
    commands: list[list[str]] = []

    def fake_lipo(command: list[str], **kwargs: object) -> object:
        commands.append(command)
        assert kwargs == {"check": False, "capture_output": True, "text": True}
        Path(command[-1]).write_bytes(builder.STATIC_ARCHIVE_MAGIC + b"onnxruntime")
        return builder.subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(builder.subprocess, "run", fake_lipo)
    output = artifact_root / "runtime" / plan.target

    builder.stage_runtime(plan, artifact_root, install, output, ort_binary)

    metadata = json.loads((output / "aurora-sherpa-runtime.json").read_text())
    assert metadata["static_libraries"] == list(builder.STATIC_LIBRARIES)
    assert len(commands) == 1
    assert commands[0][:-1] == [
        "xcrun",
        "lipo",
        str(ort_binary),
        "-thin",
        "arm64",
        "-output",
    ]
    assert Path(commands[0][-1]).name == "libonnxruntime.a"
    assert Path(commands[0][-1]).parent.name.startswith(f".{output.name}.")
    assert (output / "libonnxruntime.a").read_bytes().startswith(builder.STATIC_ARCHIVE_MAGIC)


def test_ios_device_runtime_keeps_thin_onnxruntime_archive(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    builder = load_builder()
    plan = builder.TARGETS["aarch64-apple-ios"]
    artifact_root = tmp_path / "artifacts"
    install = write_installed_static_libraries(
        builder,
        plan,
        artifact_root,
        omit=frozenset({"onnxruntime"}),
    )
    ort_binary = artifact_root / "xcframework/onnxruntime.framework/onnxruntime"
    ort_binary.parent.mkdir(parents=True)
    expected = builder.STATIC_ARCHIVE_MAGIC + b"device-onnxruntime"
    ort_binary.write_bytes(expected)

    def unexpected_lipo(*_args: object, **_kwargs: object) -> object:
        raise AssertionError("a thin iOS archive must not invoke lipo")

    monkeypatch.setattr(builder.subprocess, "run", unexpected_lipo)
    output = artifact_root / "runtime" / plan.target

    builder.stage_runtime(plan, artifact_root, install, output, ort_binary)

    assert (output / "libonnxruntime.a").read_bytes() == expected


def test_ios_runtime_rejects_non_archive_lipo_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    builder = load_builder()
    plan = builder.TARGETS["aarch64-apple-ios-sim"]
    artifact_root = tmp_path / "artifacts"
    install = write_installed_static_libraries(
        builder,
        plan,
        artifact_root,
        omit=frozenset({"onnxruntime"}),
    )
    ort_binary = artifact_root / "xcframework/onnxruntime.framework/onnxruntime"
    ort_binary.parent.mkdir(parents=True)
    ort_binary.write_bytes(b"fat static framework")

    def fake_lipo(command: list[str], **_kwargs: object) -> object:
        Path(command[-1]).write_bytes(b"not an archive")
        return builder.subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(builder.subprocess, "run", fake_lipo)
    with pytest.raises(builder.NativeBuildError, match="not a static archive"):
        builder.stage_runtime(
            plan,
            artifact_root,
            install,
            artifact_root / "runtime/incomplete-ios",
            ort_binary,
        )


def test_zip_extraction_accepts_regular_files(tmp_path: Path) -> None:
    builder = load_builder()
    archive = tmp_path / "runtime.zip"
    with zipfile.ZipFile(archive, "w") as output:
        output.writestr("onnxruntime.xcframework/Info.plist", io.BytesIO(b"plist").read())

    destination = tmp_path / "runtime"
    builder.safe_extract_zip(archive, destination)

    assert (destination / "onnxruntime.xcframework/Info.plist").read_bytes() == b"plist"
