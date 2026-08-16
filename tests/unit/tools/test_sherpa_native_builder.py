from __future__ import annotations

import importlib.util
import io
import json
import sys
import zipfile
from pathlib import Path
from types import ModuleType

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
    for target in (
        "x86_64-unknown-linux-gnu",
        "aarch64-apple-darwin",
        "x86_64-pc-windows-msvc",
    ):
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
        assert len(plan.ort_pin[1]) == 64


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
    install = artifact_root / "build/install"
    lib_dir = install / "lib"
    lib_dir.mkdir(parents=True)
    for library in builder.STATIC_LIBRARIES:
        filename = builder.static_library_filename(library, plan.target)
        (lib_dir / filename).write_bytes(f"archive:{library}".encode())

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


def test_zip_extraction_accepts_regular_files(tmp_path: Path) -> None:
    builder = load_builder()
    archive = tmp_path / "runtime.zip"
    with zipfile.ZipFile(archive, "w") as output:
        output.writestr("onnxruntime.xcframework/Info.plist", io.BytesIO(b"plist").read())

    destination = tmp_path / "runtime"
    builder.safe_extract_zip(archive, destination)

    assert (destination / "onnxruntime.xcframework/Info.plist").read_bytes() == b"plist"
