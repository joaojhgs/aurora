"""Tauri sidecar profile build policy tests."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import types
from pathlib import Path
from types import SimpleNamespace

import pytest

from scripts import build as build_script
from scripts.wheel_installer import WheelInstaller

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python 3.10 compatibility
    import tomli as tomllib

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


def pyinstaller_add_data_destinations(args: list[str]) -> list[str]:
    destinations: list[str] = []
    for arg in args:
        if not arg.startswith("--add-data="):
            continue
        destinations.append(arg.rsplit(":", maxsplit=1)[1])
    return destinations


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
def test_pockettts_is_pinned_only_in_local_tts_profiles():
    pyproject = tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))
    extras = pyproject["project"]["optional-dependencies"]
    dependency = "pocket-tts[audio]==2.1.0"

    assert dependency in extras["runtime"]
    assert dependency in extras["service-tts"]
    assert dependency in extras["sidecar-local-audio"]
    assert dependency not in extras["sidecar-thin"]


@pytest.mark.e2e
def test_thin_sidecar_export_excludes_pockettts():
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
            "sidecar-thin",
        ],
        cwd=Path.cwd(),
        text=True,
        capture_output=True,
        check=True,
    )

    assert not any(line.startswith("pocket-tts==") for line in result.stdout.splitlines())


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
def test_sidecar_profiles_without_local_embeddings_stage_bundled_defaults_disabled(
    monkeypatch, tmp_path
):
    build_dir = tmp_path / "build"
    monkeypatch.setattr(build_script, "BUILD_DIR", build_dir)
    monkeypatch.setattr(build_script, "SIDECAR_BUNDLE_CONFIG_DIR", build_dir / "sidecar-config")
    source_defaults = json.loads(build_script.DEFAULT_CONFIG_SOURCE.read_text(encoding="utf-8"))

    assert source_defaults["services"]["db"]["embeddings"]["use_local"] is True

    affected_profiles = [
        profile
        for profile in build_script.SIDECAR_PROFILES.values()
        if not build_script.sidecar_profile_bundles_local_embeddings(profile)
    ]
    assert affected_profiles

    for profile in affected_profiles:
        bundled_defaults_path = build_script.prepare_bundle_config_defaults_json(profile)
        bundled_config_path = build_script.prepare_bundle_config_json(profile)

        bundled_defaults = json.loads(bundled_defaults_path.read_text(encoding="utf-8"))
        bundled_config = json.loads(bundled_config_path.read_text(encoding="utf-8"))
        assert bundled_defaults["services"]["db"]["embeddings"]["use_local"] is False
        assert bundled_config["services"]["db"]["embeddings"]["use_local"] is False

    source_after = json.loads(build_script.DEFAULT_CONFIG_SOURCE.read_text(encoding="utf-8"))
    assert source_after["services"]["db"]["embeddings"]["use_local"] is True


@pytest.mark.e2e
def test_sidecar_profile_with_local_embeddings_keeps_bundled_defaults_enabled(
    monkeypatch, tmp_path
):
    build_dir = tmp_path / "build"
    monkeypatch.setattr(build_script, "BUILD_DIR", build_dir)
    monkeypatch.setattr(build_script, "SIDECAR_BUNDLE_CONFIG_DIR", build_dir / "sidecar-config")
    profile = build_script.SidecarProfile(
        name="local-embeddings",
        extras=("build", "sidecar-thin", "embeddings-local"),
        description="test profile with local embeddings",
    )

    bundled_defaults_path = build_script.prepare_bundle_config_defaults_json(profile)
    bundled_defaults = json.loads(bundled_defaults_path.read_text(encoding="utf-8"))

    assert build_script.sidecar_profile_bundles_local_embeddings(profile) is True
    assert bundled_defaults["services"]["db"]["embeddings"]["use_local"] is True


@pytest.mark.e2e
def test_get_platform_args_overrides_sidecar_bundled_config_defaults(monkeypatch, tmp_path):
    build_dir = tmp_path / "build"
    monkeypatch.setattr(build_script, "BUILD_DIR", build_dir)
    monkeypatch.setattr(build_script, "SIDECAR_BUNDLE_CONFIG_DIR", build_dir / "sidecar-config")
    profile = build_script.get_sidecar_profile("thin")

    args = build_script.get_platform_args(
        executable_name="aurora-sidecar",
        onefile=True,
        sidecar_profile=profile,
        dist_dir=tmp_path / "dist",
    )

    bundled_defaults_path = (
        build_dir / "sidecar-config/thin/app/services/config/config_defaults.json"
    )
    bundled_defaults = json.loads(bundled_defaults_path.read_text(encoding="utf-8"))
    source_defaults = json.loads(build_script.DEFAULT_CONFIG_SOURCE.read_text(encoding="utf-8"))
    add_data_destinations = pyinstaller_add_data_destinations(args)

    assert bundled_defaults["services"]["db"]["embeddings"]["use_local"] is False
    assert source_defaults["services"]["db"]["embeddings"]["use_local"] is True
    assert add_data_destinations.count("app") == 1
    assert "app/services/config" not in add_data_destinations
    assert f"--add-data={build_dir / 'sidecar-config/thin/app'}:app" in args


@pytest.mark.e2e
def test_non_sidecar_platform_args_keep_existing_config_data_overlay(monkeypatch, tmp_path):
    build_dir = tmp_path / "build"
    monkeypatch.setattr(build_script, "BUILD_DIR", build_dir)

    args = build_script.get_platform_args()
    add_data_destinations = pyinstaller_add_data_destinations(args)

    assert f"--add-data={build_script.PROJECT_ROOT / 'app'}:app" in args
    assert add_data_destinations.count("app") == 1
    assert add_data_destinations.count("app/services/config") == 1


@pytest.mark.e2e
def test_sidecar_bundled_config_staging_is_removed_after_build_failure(monkeypatch, tmp_path):
    build_dir = tmp_path / "build"
    dist_dir = tmp_path / "dist"
    staging_dir = build_dir / "sidecar-config"
    profile = build_script.get_sidecar_profile("thin")
    pyinstaller_module = types.ModuleType("PyInstaller")
    pyinstaller_main_module = types.ModuleType("PyInstaller.__main__")

    def fail_pyinstaller(_args):
        raise RuntimeError("simulated pyinstaller failure")

    pyinstaller_main_module.run = fail_pyinstaller
    pyinstaller_module.__main__ = pyinstaller_main_module

    monkeypatch.setitem(sys.modules, "PyInstaller", pyinstaller_module)
    monkeypatch.setitem(sys.modules, "PyInstaller.__main__", pyinstaller_main_module)
    monkeypatch.setattr(build_script, "BUILD_DIR", build_dir)
    monkeypatch.setattr(build_script, "DIST_DIR", dist_dir)
    monkeypatch.setattr(build_script, "SIDECAR_BUNDLE_CONFIG_DIR", staging_dir)
    monkeypatch.setattr(build_script, "handle_enum34_compatibility", lambda: None)
    monkeypatch.setattr(build_script, "handle_webrtcvad_hook", lambda: None)
    monkeypatch.setattr(build_script, "create_version_file", lambda: None)

    success = build_script.build_executable(
        executable_name="aurora-sidecar",
        onefile=True,
        sidecar_profile=profile,
    )

    assert success is False
    assert not staging_dir.exists()
    source_defaults = json.loads(build_script.DEFAULT_CONFIG_SOURCE.read_text(encoding="utf-8"))
    assert source_defaults["services"]["db"]["embeddings"]["use_local"] is True


@pytest.mark.e2e
def test_runtime_smoke_fails_on_missing_local_embeddings_error():
    script = Path("apps/aurora-tauri/scripts/sidecar-runtime-smoke.mjs").read_text(encoding="utf-8")

    assert "hasMissingLocalEmbeddingsError(outputTail)" in script
    assert "langchain-huggingface is required for local embeddings" in script
    assert "packaged sidecar attempted unavailable local embeddings" in script


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
    assert "pocket-tts" in exported_packages
    assert exported_packages.isdisjoint(PYTORCH_CUDA_CHILDREN)


@pytest.mark.e2e
def test_tts_process_image_uses_a_persistent_voice_model_cache():
    dockerfile = Path("docker/services/Dockerfile.tts").read_text(encoding="utf-8")
    compose = Path("docker-compose.process.yml").read_text(encoding="utf-8")
    tts_service = compose.split("  # TTS Service", maxsplit=1)[1].split(
        "  # STT Transcription Service", maxsplit=1
    )[0]

    assert "HF_HOME=/app/voice_models/pockettts/huggingface" in dockerfile
    assert "/app/voice_models/pockettts/voices" in dockerfile
    assert "/app/voice_models/voice-pack" in dockerfile
    assert dockerfile.index(
        "COPY --chown=aurora:aurora pyproject.toml uv.lock ./"
    ) < dockerfile.index("COPY --chown=aurora:aurora app/ app/")

    assert "HF_HOME=/app/voice_models/pockettts/huggingface" in tts_service
    assert "aurora_voice_models:/app/voice_models" in tts_service
    assert "\n  aurora_voice_models:\n    driver: local\n" in compose


@pytest.mark.e2e
def test_tts_docker_installs_selected_gpu_backend_before_pockettts_requirements():
    dockerfile = Path("docker/services/Dockerfile.tts").read_text(encoding="utf-8")
    cuda_branch = dockerfile.split('if [ "$TTS_HARDWARE" = "cuda" ]; then', maxsplit=1)[1].split(
        'elif [ "$TTS_HARDWARE" = "rocm" ]; then', maxsplit=1
    )[0]
    rocm_branch = dockerfile.split('elif [ "$TTS_HARDWARE" = "rocm" ]; then', maxsplit=1)[1].split(
        "else", maxsplit=1
    )[0]

    assert cuda_branch.index("torch==2.6.0+cu124") < cuda_branch.index("-r /tmp/requirements.txt")
    assert rocm_branch.index("torch==2.6.0+rocm6.2.4") < rocm_branch.index(
        "-r /tmp/requirements.txt"
    )
    assert "https://download.pytorch.org/whl/cu124" in cuda_branch
    assert "https://download.pytorch.org/whl/rocm6.2.4" in rocm_branch


@pytest.mark.e2e
def test_sidecar_installs_hardware_wheels_before_dependency_resolution(monkeypatch):
    events: list[str] = []
    profile = build_script.get_sidecar_profile("local-rocm")

    monkeypatch.setattr(
        build_script,
        "install_profile_hardware_wheels",
        lambda *_args: events.append("hardware"),
    )
    monkeypatch.setattr(
        build_script,
        "install_sidecar_profile_dependencies",
        lambda *_args, **_kwargs: events.append("dependencies"),
    )
    monkeypatch.setattr(
        build_script,
        "remove_enum34_backport",
        lambda: events.append("cleanup"),
    )
    monkeypatch.setattr(
        build_script,
        "check_sidecar_dependency_health",
        lambda: events.append("check"),
    )
    monkeypatch.setitem(sys.modules, "PyInstaller", SimpleNamespace(__version__="test"))

    build_script.ensure_dependencies(profile)

    assert events == ["hardware", "dependencies", "cleanup", "hardware", "check"]


@pytest.mark.e2e
def test_sidecar_dependency_install_uses_frozen_pruned_lock(monkeypatch):
    commands: list[list[str]] = []
    profile = build_script.get_sidecar_profile("local-rocm")

    monkeypatch.setattr(build_script.shutil, "which", lambda name: "/usr/bin/uv")
    monkeypatch.setattr(
        build_script.subprocess,
        "run",
        lambda command, **_kwargs: commands.append(command)
        or subprocess.CompletedProcess(command, 0),
    )

    build_script.install_sidecar_profile_dependencies(profile)

    export_command, requirements_command, project_command = commands
    assert export_command[:3] == ["/usr/bin/uv", "export", "--frozen"]
    assert "--no-dev" in export_command
    assert "--no-emit-project" in export_command
    for extra in profile.extras:
        assert ["--extra", extra] == export_command[
            export_command.index(extra) - 1 : export_command.index(extra) + 1
        ]
    for package in ("torch", "torchaudio", "torchvision"):
        assert ["--prune", package] == export_command[
            export_command.index(package) - 1 : export_command.index(package) + 1
        ]
    assert export_command[
        export_command.index("enum34") - 1 : export_command.index("enum34") + 1
    ] == ["--prune", "enum34"]
    assert requirements_command[:5] == [
        "/usr/bin/uv",
        "pip",
        "install",
        "--python",
        sys.executable,
    ]
    assert project_command[:6] == [
        "/usr/bin/uv",
        "pip",
        "install",
        "--python",
        sys.executable,
        "--no-deps",
    ]


@pytest.mark.e2e
def test_enum34_cleanup_targets_active_interpreter_and_repairs_metadata(monkeypatch):
    commands: list[list[str]] = []
    repairs: list[bool] = []
    monkeypatch.setattr(build_script.shutil, "which", lambda name: "/usr/bin/uv")
    monkeypatch.setattr(
        build_script.subprocess,
        "run",
        lambda command, **_kwargs: commands.append(command)
        or subprocess.CompletedProcess(command, 0, stdout="", stderr=""),
    )
    monkeypatch.setattr(
        build_script,
        "_remove_invalid_pvporcupine_enum34_requirement",
        lambda: repairs.append(True) or True,
    )

    build_script.remove_enum34_backport()

    assert commands == [["/usr/bin/uv", "pip", "uninstall", "--python", sys.executable, "enum34"]]
    assert repairs == [True]


@pytest.mark.e2e
def test_pvporcupine_metadata_repair_removes_only_enum34(monkeypatch, tmp_path):
    metadata_path = tmp_path / "pvporcupine-1.9.5.dist-info" / "METADATA"
    metadata_path.parent.mkdir()
    metadata_path.write_text(
        "Metadata-Version: 2.1\n"
        "Name: pvporcupine\n"
        "Version: 1.9.5\n"
        "Requires-Dist: enum34\n"
        "Requires-Dist: numpy\n",
        encoding="utf-8",
    )
    metadata_entry = Path("pvporcupine-1.9.5.dist-info/METADATA")
    distribution = SimpleNamespace(
        version="1.9.5",
        files=(metadata_entry,),
        locate_file=lambda _entry: metadata_path,
    )
    monkeypatch.setattr(
        build_script.importlib_metadata,
        "distribution",
        lambda _name: distribution,
    )

    assert build_script._remove_invalid_pvporcupine_enum34_requirement() is True

    repaired = metadata_path.read_text(encoding="utf-8")
    assert "Requires-Dist: enum34" not in repaired
    assert "Requires-Dist: numpy" in repaired


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
def test_rocm_sidecar_excludes_only_nvidia_triton_backend():
    profile = build_script.get_sidecar_profile("local-rocm")
    args = build_script.get_platform_args(
        executable_name="aurora-sidecar",
        onefile=True,
        sidecar_profile=profile,
        dist_dir=Path("dist/sidecars/local-rocm"),
    )

    assert "--exclude-module=triton.backends.nvidia" in args
    assert "--exclude-module=triton" not in args
    assert "--exclude-module=torch" not in args


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
def test_wheel_installer_builds_uv_uninstall_for_current_interpreter(monkeypatch):
    installer = WheelInstaller()
    monkeypatch.setattr("scripts.wheel_installer.shutil.which", lambda name: "/usr/bin/uv")

    command = installer._uninstall_command(["torch", "triton"])

    assert command == [
        "/usr/bin/uv",
        "pip",
        "uninstall",
        "--python",
        sys.executable,
        "torch",
        "triton",
    ]


@pytest.mark.e2e
def test_wheel_installer_skips_clean_matching_pytorch_backend(monkeypatch):
    installer = WheelInstaller()
    calls: list[tuple[str, list[str]]] = []
    monkeypatch.setattr(
        installer,
        "_installed_distributions",
        lambda: {
            "torch": "2.6.0+rocm6.2.4",
            "torchaudio": "2.6.0+rocm6.2.4",
            "torchvision": "0.21.0+rocm6.2.4",
            "onnxruntime": "1.20.1",
            "pytorch-triton-rocm": "3.2.0",
        },
    )
    monkeypatch.setattr(
        installer, "_pip_uninstall", lambda packages: calls.append(("uninstall", packages)) or True
    )
    monkeypatch.setattr(
        installer, "_pip_install", lambda packages: calls.append(("install", packages)) or True
    )

    assert installer.install_pytorch("rocm") is True
    assert calls == []


@pytest.mark.e2e
def test_wheel_installer_cleans_cuda_contamination_before_rocm_install(monkeypatch):
    installer = WheelInstaller()
    calls: list[tuple[str, list[str]]] = []
    monkeypatch.setattr(
        installer,
        "_installed_distributions",
        lambda: {
            "torch": "2.6.0+cu124",
            "torchaudio": "2.6.0+cu124",
            "torchvision": "0.21.0+cu124",
            "nvidia-cublas-cu12": "12.4.5.8",
            "nvidia-cudnn-cu12": "9.1.0.70",
            "triton": "3.2.0",
            "pytorch-triton-rocm": "3.2.0",
            "onnxruntime": "1.20.1",
        },
    )
    monkeypatch.setattr(
        installer, "_pip_uninstall", lambda packages: calls.append(("uninstall", packages)) or True
    )
    monkeypatch.setattr(
        installer, "_pip_install", lambda packages: calls.append(("install", packages)) or True
    )

    assert installer.install_pytorch("rocm") is True

    assert calls[0] == (
        "uninstall",
        [
            "nvidia-cublas-cu12",
            "nvidia-cudnn-cu12",
            "pytorch-triton-rocm",
            "torch",
            "torchaudio",
            "torchvision",
            "triton",
        ],
    )
    assert calls[1][0] == "install"
    assert "torch==2.6.0+rocm6.2.4" in calls[1][1]
    assert calls[1][1].index("torch==2.6.0+rocm6.2.4") < calls[1][1].index(
        "--extra-index-url=https://download.pytorch.org/whl/rocm6.2.4"
    )


@pytest.mark.e2e
def test_wheel_installer_repairs_non_cuda_onnxruntime_gpu(monkeypatch):
    installer = WheelInstaller()
    calls: list[tuple[str, list[str]]] = []
    monkeypatch.setattr(
        installer,
        "_installed_distributions",
        lambda: {
            "torch": "2.6.0+cpu",
            "torchaudio": "2.6.0+cpu",
            "torchvision": "0.21.0+cpu",
            "onnxruntime": "1.20.1",
            "onnxruntime-gpu": "1.23.2",
        },
    )
    monkeypatch.setattr(
        installer, "_pip_uninstall", lambda packages: calls.append(("uninstall", packages)) or True
    )
    monkeypatch.setattr(
        installer, "_pip_install", lambda packages: calls.append(("install", packages)) or True
    )

    assert installer.install_pytorch("cpu") is True

    assert calls == [
        ("uninstall", ["onnxruntime-gpu"]),
        ("install", ["--force-reinstall", "--no-deps", "onnxruntime==1.20.1", "numpy==2.2.6"]),
    ]


@pytest.mark.e2e
def test_wheel_installer_fails_closed_when_backend_cleanup_fails(monkeypatch):
    installer = WheelInstaller()
    calls: list[tuple[str, list[str]]] = []
    monkeypatch.setattr(
        installer,
        "_installed_distributions",
        lambda: {
            "torch": "2.6.0+cu124",
            "torchaudio": "2.6.0+cu124",
            "torchvision": "0.21.0+cu124",
            "nvidia-cublas-cu12": "12.4.5.8",
        },
    )
    monkeypatch.setattr(
        installer, "_pip_uninstall", lambda packages: calls.append(("uninstall", packages)) or False
    )
    monkeypatch.setattr(
        installer, "_pip_install", lambda packages: calls.append(("install", packages)) or True
    )

    assert installer.install_pytorch("rocm") is False
    assert calls[0][0] == "uninstall"
    assert not any(kind == "install" for kind, _packages in calls)


@pytest.mark.e2e
def test_sidecar_dependency_install_failure_is_fatal(monkeypatch):
    profile = build_script.get_sidecar_profile("local-cpu")
    monkeypatch.setattr(Path, "exists", lambda self: True)

    def fail_install(*args, **kwargs):
        raise subprocess.CalledProcessError(1, ["uv", "pip", "install"])

    monkeypatch.setattr(build_script, "install_profile_hardware_wheels", lambda *_args: None)
    monkeypatch.setattr(build_script, "install_sidecar_profile_dependencies", fail_install)

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
def test_prepare_sidecar_desktop_local_minimal_uses_thin_build_output(tmp_path):
    sidecar_dir = Path("dist/sidecars/thin")
    fake = tmp_path / "thin-build" / "aurora-sidecar"
    output_dir = Path("apps/aurora-tauri/src-tauri/binaries")
    target_triple = "test-thin-build-output"
    extension = ".exe" if sys.platform == "win32" else ""
    output_path = output_dir / f"aurora-sidecar-{target_triple}{extension}"
    report_path = Path("apps/aurora-tauri/reports/sidecar-prepare.json")
    release_config_path = Path("apps/aurora-tauri/src-tauri/tauri.release.conf.json")
    real_sidecar_dir_exists = sidecar_dir.exists()
    fake.parent.mkdir(parents=True, exist_ok=True)
    fake.write_text("#!/bin/sh\necho fake thin sidecar\n", encoding="utf-8")
    fake.chmod(0o755)
    existing_output = output_path.read_bytes() if output_path.exists() else None
    existing_report = report_path.read_bytes() if report_path.exists() else None
    existing_release_config = (
        release_config_path.read_bytes() if release_config_path.exists() else None
    )

    env = {
        **os.environ,
        "AURORA_TAURI_SIDECAR_AUTOBUILD": "0",
        "AURORA_TAURI_SIDECAR_BUILD_OUTPUT": str(fake),
        "AURORA_TAURI_SIDECAR_MAX_MB": "1",
        "AURORA_TAURI_TARGET_TRIPLE": target_triple,
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
        assert sidecar_dir.exists() is real_sidecar_dir_exists
    finally:
        if existing_output is None:
            output_path.unlink(missing_ok=True)
        else:
            output_path.write_bytes(existing_output)
        if existing_report is None:
            report_path.unlink(missing_ok=True)
        else:
            report_path.write_bytes(existing_report)
        if existing_release_config is None:
            release_config_path.unlink(missing_ok=True)
        else:
            release_config_path.write_bytes(existing_release_config)


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
