from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
MOBILE_WORKFLOWS = (
    REPO_ROOT / ".github/workflows/tauri-android.yml",
    REPO_ROOT / ".github/workflows/tauri-ios.yml",
)
MOBILE_WEBRTC_TRIGGER_PATHS = (
    "app/messaging/mesh_bus.py",
    "app/services/auth/**",
    "app/services/config/**",
    "app/services/db/**",
    "app/services/gateway/service.py",
    "app/services/gateway/mesh/**",
    "app/services/gateway/webrtc/**",
    "app/services/gateway/utils/crypto.py",
    "app/services/tooling/**",
    "app/shared/auth/**",
    "app/shared/config/**",
    "app/shared/contracts/**",
)
MOBILE_NATIVE_TRIGGER_PATHS = (
    "packages/aurora-mesh-authority-web/**",
    "rust/crates/**",
    "tools/voice-runtime/**",
)


@pytest.mark.parametrize("workflow", MOBILE_WORKFLOWS, ids=lambda path: path.stem)
def test_mobile_workflows_run_for_backend_webrtc_contract_changes(workflow: Path) -> None:
    text = workflow.read_text(encoding="utf-8")

    for trigger_path in MOBILE_WEBRTC_TRIGGER_PATHS:
        assert f'- "{trigger_path}"' in text


@pytest.mark.parametrize("workflow", MOBILE_WORKFLOWS, ids=lambda path: path.stem)
def test_mobile_workflows_run_for_shared_native_runtime_changes(workflow: Path) -> None:
    text = workflow.read_text(encoding="utf-8")

    for trigger_path in MOBILE_NATIVE_TRIGGER_PATHS:
        assert f'- "{trigger_path}"' in text


def test_android_workflow_runs_for_every_matching_pr_update() -> None:
    text = (REPO_ROOT / ".github/workflows/tauri-android.yml").read_text(encoding="utf-8")

    assert "types: [opened, synchronize, reopened, ready_for_review]" in text


def test_desktop_workflow_runs_for_shared_native_and_authority_changes() -> None:
    text = (REPO_ROOT / ".github/workflows/tauri-desktop.yml").read_text(encoding="utf-8")

    for trigger_path in MOBILE_NATIVE_TRIGGER_PATHS:
        assert f'- "{trigger_path}"' in text


def test_webrtc_workflow_executes_native_transport_on_android() -> None:
    text = (REPO_ROOT / ".github/workflows/webrtc-interop.yml").read_text(encoding="utf-8")

    assert "android-native-transport-interop:" in text
    assert "targets: x86_64-linux-android" in text
    assert "reactivecircus/android-emulator-runner@v2" in text
    assert "scripts/webrtc_native_android_interop.sh" in text


def test_unsigned_release_reuses_every_platform_package_workflow() -> None:
    release = (REPO_ROOT / ".github/workflows/release-unsigned.yml").read_text(encoding="utf-8")

    for workflow in (
        "tauri-desktop.yml",
        "tauri-android.yml",
        "tauri-ios.yml",
    ):
        assert f"uses: ./.github/workflows/{workflow}" in release
        reusable = (REPO_ROOT / ".github/workflows" / workflow).read_text(encoding="utf-8")
        assert "workflow_call:" in reusable

    for artifact in (
        "tauri-desktop-client-*",
        "aurora-android-client-debug-*",
        "aurora-ios-client-simulator",
    ):
        assert f"pattern: {artifact}" in release

    assert "publish-release-assets:" in release
    assert 'tag="${{ needs.create-release.outputs.tag }}"' in release


def test_ios_release_archive_uses_deterministic_app_resolver() -> None:
    workflow = (REPO_ROOT / ".github/workflows/tauri-ios.yml").read_text(encoding="utf-8")

    assert "ios-simulator-smoke.mjs --print-app-path" in workflow
    assert "find apps/aurora-tauri/src-tauri/gen/apple" not in workflow
    assert "head -n 1" not in workflow


def test_frontend_workflow_builds_mesh_authority_before_sdk_tests() -> None:
    text = (REPO_ROOT / ".github/workflows/frontend-sdk.yml").read_text(encoding="utf-8")

    authority_build = text.index("pnpm --filter @aurora/mesh-authority-web build")
    sdk_test = text.index("pnpm --filter @aurora/client test:coverage")
    assert authority_build < sdk_test


@pytest.mark.parametrize(
    ("workflow_name", "downstream_command"),
    (
        ("quality.yml", "pnpm --filter @aurora/web typecheck"),
        (
            "sdk-backend-contract-conformance.yml",
            "pnpm --filter @aurora/client test",
        ),
        ("release.yml", "pnpm --filter @aurora/client build"),
        ("release-unsigned.yml", "pnpm --filter @aurora/client build"),
        ("webrtc-interop.yml", "pnpm test:hosted-peer:live"),
        ("tauri-android.yml", "android:webrtc:interop"),
        ("tauri-ios.yml", "ios:webrtc:interop"),
    ),
)
def test_ci_builds_mesh_authority_before_dependent_checks(
    workflow_name: str,
    downstream_command: str,
) -> None:
    text = (REPO_ROOT / ".github/workflows" / workflow_name).read_text(encoding="utf-8")

    authority_build = text.index("pnpm --filter @aurora/mesh-authority-web build")
    dependent_check = text.index(downstream_command)
    assert authority_build < dependent_check


def test_every_desktop_live_job_builds_mesh_authority() -> None:
    text = (REPO_ROOT / ".github/workflows/tauri-desktop.yml").read_text(encoding="utf-8")
    authority_command = "pnpm --filter @aurora/mesh-authority-web build"
    live_command = "pnpm test:desktop-client:live"

    live_offsets = [offset for offset in range(len(text)) if text.startswith(live_command, offset)]
    assert len(live_offsets) == 2
    for live_offset in live_offsets:
        assert text.rfind(authority_command, 0, live_offset) != -1


def test_unsigned_release_uses_the_exact_semantic_release_version_and_tag() -> None:
    release = (REPO_ROOT / ".github/workflows/release-unsigned.yml").read_text(encoding="utf-8")

    assert "--as-prerelease --prerelease-token rc" in release
    assert "id: release" in release
    assert "root_options:" not in release
    assert "strict: true" in release
    assert 'tag="${{ needs.create-release.outputs.tag }}"' in release
    assert ('${{ needs.create-release.outputs.version }}" != "$expected_version') in release


@pytest.mark.parametrize("workflow_name", ("release.yml", "release-unsigned.yml"))
def test_release_actions_use_supported_v10_inputs(workflow_name: str) -> None:
    release = (REPO_ROOT / ".github/workflows" / workflow_name).read_text(encoding="utf-8")

    assert "root_options:" not in release
    assert 'verbosity: "2"' in release
    assert "strict: true" in release


def test_tauri_release_version_script_updates_semver_and_android_code(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "tauri.conf.json"
    config_path.write_text(
        json.dumps(
            {
                "version": "1.0.0",
                "bundle": {"android": {"versionCode": 100}},
            }
        ),
        encoding="utf-8",
    )
    result = subprocess.run(
        [
            "node",
            str(REPO_ROOT / "scripts/set_tauri_release_version.mjs"),
            "2.3.4-rc.5",
        ],
        cwd=REPO_ROOT,
        env={
            **os.environ,
            "AURORA_TAURI_RELEASE_CONFIG_PATH": str(config_path),
        },
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    updated = json.loads(config_path.read_text(encoding="utf-8"))
    assert updated["version"] == "2.3.4-rc.5"
    assert updated["bundle"]["android"]["versionCode"] == 2_003_004


def test_tauri_release_version_script_rejects_unrepresentable_versions(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "tauri.conf.json"
    original = '{"version":"1.0.0","bundle":{"android":{"versionCode":100}}}\\n'
    config_path.write_text(original, encoding="utf-8")
    result = subprocess.run(
        [
            "node",
            str(REPO_ROOT / "scripts/set_tauri_release_version.mjs"),
            "1.1000.0",
        ],
        cwd=REPO_ROOT,
        env={
            **os.environ,
            "AURORA_TAURI_RELEASE_CONFIG_PATH": str(config_path),
        },
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert config_path.read_text(encoding="utf-8") == original
