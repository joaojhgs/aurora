"""Tauri sidecar profile build policy tests."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest

from scripts import build as build_script
from scripts.wheel_installer import WheelInstaller

PYTORCH_CUDA_CHILDREN = {
    "nvidia-cublas-cu12",
    "nvidia-cuda-cupti-cu12",
    "nvidia-cuda-nvrtc-cu12",
    "nvidia-cuda-runtime-cu12",
    "nvidia-cudnn-cu12",
    "nvidia-cufft-cu12",
    "nvidia-curand-cu12",
    "nvidia-cusolver-cu12",
    "nvidia-cusparse-cu12",
    "nvidia-cusparselt-cu12",
    "nvidia-nccl-cu12",
    "nvidia-nvjitlink-cu12",
    "nvidia-nvtx-cu12",
    "triton",
}


@pytest.mark.e2e
def test_thin_sidecar_profile_avoids_full_runtime_and_local_ai_modules():
    profile = build_script.get_sidecar_profile("thin")

    assert profile.name == "thin"
    assert "runtime" not in profile.extras
    assert "torch-cpu" not in profile.extras
    assert "sidecar-thin" in profile.extras
    assert profile.hardware is None
    assert "torch" in profile.excludes
    assert "app.services.tts" in profile.excludes

    args = build_script.get_platform_args(
        executable_name="aurora-sidecar",
        onefile=True,
        sidecar_profile=profile,
        dist_dir=Path("dist/sidecars/thin"),
    )
    assert "--onefile" in args
    assert "--hidden-import=passlib.handlers.argon2" in args
    assert "--optimize=1" in args
    assert "--optimize=2" not in args
    assert "--exclude-module=torch" in args
    assert "--exclude-module=app.services.tts" in args
    assert not any("modules:modules" in arg for arg in args)
    assert any(arg == "--distpath=dist/sidecars/thin" for arg in args)


@pytest.mark.e2e
def test_sidecar_thin_profile_pins_numpy_abi_version():
    pyproject = tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))
    sidecar_thin = pyproject["project"]["optional-dependencies"]["sidecar-thin"]

    assert "numpy==2.2.6" in sidecar_thin


@pytest.mark.e2e
def test_local_profiles_are_explicit_and_profile_specific():
    cpu = build_script.get_sidecar_profile("local-cpu")
    cuda = build_script.get_sidecar_profile("local-cuda")
    full = build_script.get_sidecar_profile("full")

    assert cpu.hardware == "cpu"
    assert "sidecar-local-audio" in cpu.extras
    assert "torch-cpu" in cpu.extras
    assert cuda.hardware == "cuda"
    assert "cuda" in cuda.extras
    assert "runtime" not in cuda.extras
    assert full.extras == ("build", "runtime", "torch-cpu")

    assert build_script.sidecar_dist_dir(cpu) == build_script.DIST_DIR / "sidecars" / "local-cpu"
    assert build_script.sidecar_dist_dir(cuda) == build_script.DIST_DIR / "sidecars" / "local-cuda"

    args = build_script.get_platform_args()
    assert "--optimize=2" in args


@pytest.mark.e2e
def test_tts_cpu_constraints_pin_full_cpu_torch_triplet():
    constraints = Path("docker/services/constraints-tts-cpu.txt").read_text(encoding="utf-8")

    assert "torch==2.6.0+cpu" in constraints
    assert "torchaudio==2.6.0+cpu" in constraints
    assert "torchvision==0.21.0+cpu" in constraints


@pytest.mark.e2e
def test_tts_docker_cpu_requirements_export_prunes_pytorch_subtrees():
    result = subprocess.run(
        [
            "uv",
            "export",
            "--frozen",
            "--no-dev",
            "--no-emit-project",
            "--format",
            "requirements.txt",
            "--extra",
            "service-tts",
            "--extra",
            "mode-processes",
            "--prune",
            "torch",
            "--prune",
            "torchaudio",
            "--prune",
            "torchvision",
        ],
        cwd=Path.cwd(),
        text=True,
        capture_output=True,
        check=True,
    )
    exported_packages = {
        line.partition("==")[0].strip().lower()
        for line in result.stdout.splitlines()
        if line and not line.startswith("#") and "==" in line
    }

    assert "torch" not in exported_packages
    assert "torchaudio" not in exported_packages
    assert "torchvision" not in exported_packages
    assert exported_packages.isdisjoint(PYTORCH_CUDA_CHILDREN)


@pytest.mark.e2e
def test_tts_rocm_pytorch_triplet_resolves():
    result = subprocess.run(
        [
            "uv",
            "pip",
            "install",
            "--dry-run",
            "torch==2.6.0+rocm6.2.4",
            "torchaudio==2.6.0+rocm6.2.4",
            "torchvision==0.21.0+rocm6.2.4",
            "--extra-index-url=https://download.pytorch.org/whl/rocm6.2.4",
            "--index-strategy",
            "unsafe-best-match",
        ],
        cwd=Path.cwd(),
        text=True,
        capture_output=True,
        check=True,
    )

    output = result.stdout + result.stderr
    assert "torch==2.6.0+rocm6.2.4" in output
    assert "torchaudio==2.6.0+rocm6.2.4" in output
    assert "torchvision==0.21.0+rocm6.2.4" in output


@pytest.mark.e2e
def test_cpu_like_sidecar_profiles_force_cpu_torch_wheels():
    for profile_name in (
        "local-cpu",
        "local-metal",
        "local-vulkan",
        "local-sycl",
        "local-rpc",
        "full",
    ):
        profile = build_script.get_sidecar_profile(profile_name)
        uv_args, pip_args = build_script.profile_install_args(profile)

        assert profile.force_cpu_torch_wheels is True
        assert "--constraint" in uv_args
        assert "--index-strategy" in uv_args
        assert "--index-strategy" not in pip_args
        assert "https://download.pytorch.org/whl/cpu" in uv_args
        assert "https://download.pytorch.org/whl/cpu" in pip_args

    for profile_name in ("thin", "local-cuda", "local-rocm"):
        profile = build_script.get_sidecar_profile(profile_name)
        assert profile.force_cpu_torch_wheels is False
        assert build_script.profile_install_args(profile) == ((), ())


@pytest.mark.e2e
def test_wheel_installer_cpu_like_pytorch_backends_use_cpu_wheel_index():
    installer = WheelInstaller()

    for backend in ("cpu", "metal", "vulkan", "sycl", "rpc"):
        packages = installer.wheel_configs["pytorch"][backend]["primary"]
        assert "torch==2.6.0+cpu" in packages
        assert "torchaudio==2.6.0+cpu" in packages
        assert "torchvision==0.21.0+cpu" in packages
        assert "--extra-index-url=https://download.pytorch.org/whl/cpu" in packages


@pytest.mark.e2e
def test_wheel_installer_rocm_pytorch_backend_uses_resolvable_triplet():
    packages = WheelInstaller().wheel_configs["pytorch"]["rocm"]["primary"]

    assert "torch==2.6.0+rocm6.2.4" in packages
    assert "torchaudio==2.6.0+rocm6.2.4" in packages
    assert "torchvision==0.21.0+rocm6.2.4" in packages
    assert "--extra-index-url=https://download.pytorch.org/whl/rocm6.2.4" in packages


@pytest.mark.e2e
def test_wheel_installer_prefers_uv_targeting_current_interpreter(monkeypatch):
    installer = WheelInstaller()
    monkeypatch.setattr("scripts.wheel_installer.shutil.which", lambda name: "/usr/bin/uv")

    command = installer._install_command(["torch==2.6.0+cpu", "--prefer-binary"])

    assert command == [
        "/usr/bin/uv",
        "pip",
        "install",
        "--python",
        sys.executable,
        "torch==2.6.0+cpu",
    ]


@pytest.mark.e2e
def test_wheel_installer_uses_pip_fallback_only_when_available(monkeypatch):
    installer = WheelInstaller()
    monkeypatch.setattr("scripts.wheel_installer.shutil.which", lambda name: None)
    monkeypatch.setattr(installer, "_pip_available", lambda: True)

    assert installer._install_command(["llama-cpp-python"]) == [
        sys.executable,
        "-m",
        "pip",
        "install",
        "llama-cpp-python",
    ]


@pytest.mark.e2e
def test_wheel_installer_fails_closed_without_uv_or_pip(monkeypatch):
    installer = WheelInstaller()
    monkeypatch.setattr("scripts.wheel_installer.shutil.which", lambda name: None)
    monkeypatch.setattr(installer, "_pip_available", lambda: False)

    with pytest.raises(RuntimeError, match="Neither uv nor pip"):
        installer._install_command(["llama-cpp-python"])


@pytest.mark.e2e
def test_sidecar_dependency_install_failure_is_fatal(monkeypatch):
    profile = build_script.get_sidecar_profile("local-cpu")
    monkeypatch.setattr(Path, "exists", lambda self: True)

    def fail_install(*args, **kwargs):
        raise subprocess.CalledProcessError(1, ["uv", "pip", "install"])

    monkeypatch.setattr(build_script, "install_python_packages", fail_install)

    with pytest.raises(build_script.click.ClickException, match="local-cpu"):
        build_script.ensure_dependencies(profile)


@pytest.mark.e2e
def test_non_sidecar_dependency_install_can_use_core_build_fallback(monkeypatch):
    calls = []
    monkeypatch.setattr(Path, "exists", lambda self: True)
    monkeypatch.setitem(
        sys.modules, "PyInstaller", type("PyInstaller", (), {"__version__": "test"})
    )
    monkeypatch.setattr(build_script, "remove_enum34_backport", lambda: None)

    def install(args, **kwargs):
        calls.append(args)
        if len(calls) == 1:
            raise subprocess.CalledProcessError(1, ["uv", "pip", "install"])

    monkeypatch.setattr(build_script, "install_python_packages", install)

    build_script.ensure_dependencies(None)

    assert calls[0] == ["-e", ".[build,runtime,torch-cpu]"]
    assert calls[1] == ["pyinstaller>=6.0.0", "auto-py-to-exe>=2.4.0"]


@pytest.mark.e2e
def test_sidecar_wheel_installer_failure_is_fatal(monkeypatch):
    profile = build_script.get_sidecar_profile("local-cpu")
    monkeypatch.setattr(Path, "exists", lambda self: True)
    monkeypatch.setitem(
        sys.modules, "PyInstaller", type("PyInstaller", (), {"__version__": "test"})
    )
    monkeypatch.setattr(build_script, "install_python_packages", lambda *args, **kwargs: None)
    monkeypatch.setattr(build_script, "remove_enum34_backport", lambda: None)

    def fail_run(*args, **kwargs):
        raise subprocess.CalledProcessError(1, args[0])

    monkeypatch.setattr(build_script.subprocess, "run", fail_run)

    with pytest.raises(build_script.click.ClickException, match="local-cpu"):
        build_script.ensure_dependencies(profile)


@pytest.mark.e2e
def test_prepare_sidecar_profiles_stage_profile_report_with_fake_binary(tmp_path):
    fake = tmp_path / "aurora-sidecar"
    fake.write_text("#!/bin/sh\necho fake sidecar\n", encoding="utf-8")
    fake.chmod(0o755)

    env = {
        **os.environ,
        "AURORA_TAURI_SIDECAR_BUILD_OUTPUT": str(fake),
        "AURORA_TAURI_SIDECAR_MAX_MB": "1",
    }
    result = subprocess.run(
        ["node", "apps/aurora-tauri/scripts/prepare-sidecar.mjs", "--profile", "local-cuda"],
        cwd=Path.cwd(),
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr + result.stdout
    report_path = Path("apps/aurora-tauri/reports/sidecar-prepare.json")
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["sidecarProfile"] == "local-cuda"
    assert report["sourceKind"] == "existing-build-output"
    assert report["sourceSizeMb"] < 1
    assert report["secretsRedacted"] is True
    assert "<host-path-redacted>" in report["sourcePath"]


@pytest.mark.e2e
def test_prepare_sidecar_desktop_local_minimal_uses_thin_build_output():
    sidecar_dir = Path("dist/sidecars/thin")
    fake = sidecar_dir / "aurora-sidecar"
    output_dir = Path("apps/aurora-tauri/src-tauri/binaries")
    report_path = Path("apps/aurora-tauri/reports/sidecar-prepare.json")
    release_config_path = Path("apps/aurora-tauri/src-tauri/tauri.release.conf.json")
    shutil.rmtree(sidecar_dir, ignore_errors=True)
    fake.parent.mkdir(parents=True, exist_ok=True)
    fake.write_text("#!/bin/sh\necho fake thin sidecar\n", encoding="utf-8")
    fake.chmod(0o755)

    env = {
        **os.environ,
        "AURORA_TAURI_SIDECAR_AUTOBUILD": "0",
        "AURORA_TAURI_SIDECAR_MAX_MB": "1",
    }
    result = subprocess.run(
        [
            "node",
            "apps/aurora-tauri/scripts/prepare-sidecar.mjs",
            "--profile",
            "desktop-local-minimal",
        ],
        cwd=Path.cwd(),
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    try:
        assert result.returncode == 0, result.stderr + result.stdout
        report = json.loads(report_path.read_text(encoding="utf-8"))
        assert report["sidecarProfile"] == "desktop-local-minimal"
        assert report["sourceKind"] == "existing-build-output"
    finally:
        shutil.rmtree(sidecar_dir, ignore_errors=True)
        for generated in output_dir.glob("aurora-sidecar-*"):
            generated.unlink()
        report_path.unlink(missing_ok=True)
        release_config_path.unlink(missing_ok=True)


@pytest.mark.e2e
def test_prepare_sidecar_autobuild_uses_isolated_uv_environment():
    script = Path("apps/aurora-tauri/scripts/prepare-sidecar.mjs").read_text(encoding="utf-8")

    assert "'--isolated'" in script
    assert "'--no-dev'" in script
    assert "isolated uv environment" in script


@pytest.mark.e2e
def test_tauri_platform_bundle_targets_keep_linux_rpm_opt_in():
    linux = json.loads(
        Path("apps/aurora-tauri/src-tauri/tauri.linux.conf.json").read_text(encoding="utf-8")
    )
    macos = json.loads(
        Path("apps/aurora-tauri/src-tauri/tauri.macos.conf.json").read_text(encoding="utf-8")
    )
    windows = json.loads(
        Path("apps/aurora-tauri/src-tauri/tauri.windows.conf.json").read_text(encoding="utf-8")
    )
    package = json.loads(Path("apps/aurora-tauri/package.json").read_text(encoding="utf-8"))

    assert linux["bundle"]["targets"] == ["appimage", "deb"]
    assert macos["bundle"]["targets"] == ["dmg"]
    assert windows["bundle"]["targets"] == ["msi", "nsis"]
    assert "--bundles rpm" in package["scripts"]["build:bundle:linux-rpm:desktop-client"]
    assert (
        package["scripts"]["build:bundle:linux-rpm:thin"]
        == "pnpm build:bundle:linux-rpm:desktop-client"
    )
