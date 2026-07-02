"""Tauri sidecar profile build policy tests."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from scripts import build as build_script


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
    assert "--exclude-module=torch" in args
    assert "--exclude-module=app.services.tts" in args
    assert not any("modules:modules" in arg for arg in args)
    assert any(arg == "--distpath=dist/sidecars/thin" for arg in args)


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
def test_prepare_sidecar_autobuild_uses_isolated_uv_environment():
    script = Path("apps/aurora-tauri/scripts/prepare-sidecar.mjs").read_text(encoding="utf-8")

    assert "'--isolated'" in script
    assert "'--no-dev'" in script
    assert "isolated uv environment" in script


@pytest.mark.e2e
def test_tauri_platform_bundle_targets_keep_linux_rpm_opt_in():
    linux = json.loads(Path("apps/aurora-tauri/src-tauri/tauri.linux.conf.json").read_text(encoding="utf-8"))
    macos = json.loads(Path("apps/aurora-tauri/src-tauri/tauri.macos.conf.json").read_text(encoding="utf-8"))
    windows = json.loads(Path("apps/aurora-tauri/src-tauri/tauri.windows.conf.json").read_text(encoding="utf-8"))
    package = json.loads(Path("apps/aurora-tauri/package.json").read_text(encoding="utf-8"))

    assert linux["bundle"]["targets"] == ["appimage", "deb"]
    assert macos["bundle"]["targets"] == ["dmg"]
    assert windows["bundle"]["targets"] == ["msi", "nsis"]
    assert "--bundles rpm" in package["scripts"]["build:bundle:linux-rpm:thin"]
