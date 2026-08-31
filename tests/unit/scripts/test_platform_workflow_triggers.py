from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python 3.10 compatibility
    import tomli as tomllib

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
PRIVILEGED_WORKFLOWS = (
    REPO_ROOT / ".github/workflows/release.yml",
    REPO_ROOT / ".github/workflows/docker-build.yml",
    REPO_ROOT / ".github/workflows/sherpa-pockettts-language-packs.yml",
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
    assert '- "apps/aurora-tauri/src-tauri/android/**"' in text
    assert '- "rust/crates/aurora-voice-native/**"' in text


def test_android_workflow_runs_packaged_local_voice_without_a_gateway_fixture() -> None:
    workflow = (REPO_ROOT / ".github/workflows/tauri-android.yml").read_text(encoding="utf-8")
    harness = (REPO_ROOT / "apps/aurora-tauri/scripts/android-voice-live-smoke.mjs").read_text(
        encoding="utf-8"
    )

    assert "android:build:voice-live:apk:x86_64" in workflow
    assert "android-native-voice-live.apk" in workflow
    assert "android:voice:live" in workflow
    assert "createGatewayFixture" not in harness
    assert "/api/Orchestrator/ExternalUserInput" not in harness
    assert "assistantRoute: 'local-only'" in harness


def test_native_webrtc_workflow_uses_uv_managed_python() -> None:
    workflow = (REPO_ROOT / ".github/workflows/webrtc-interop.yml").read_text(encoding="utf-8")
    runner = (REPO_ROOT / "scripts/webrtc_native_interop.sh").read_text(encoding="utf-8")

    assert "uv sync --frozen --extra gateway" in workflow
    assert "AURORA_NATIVE_INTEROP_PYTHON: python3" not in workflow
    assert "$repo_root/.venv/bin/python3" in runner


def test_canonical_release_reuses_every_platform_package_workflow() -> None:
    release = (REPO_ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")

    assert not (REPO_ROOT / ".github/workflows/release-unsigned.yml").exists()

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
        "tauri-desktop-local-*",
        "aurora-release-android-*",
        "aurora-ios-client-simulator",
        "aurora-release-portable",
    ):
        assert f"pattern: {artifact}" in release

    assert "publish-release-assets:" in release
    assert "build-portable-packages:" in release
    assert "validate-containers:" in release
    assert "publish-containers:" in release
    assert "scripts/prepare_release_assets.mjs" in release
    assert "scripts/generate_release_changelog.mjs" in release
    assert "scripts/package_server_release.mjs" in release
    assert 'tag="${{ needs.create-release.outputs.tag }}"' in release
    assert "previous_tag: ${{ steps.history.outputs.previous_tag }}" in release
    assert "--changelog" in release
    assert "aurora-$version-full-changelog.md" in release
    assert 'gh release edit "$tag" --notes-file' in release

    validation = release.index("  validate-release-package-set:")
    create = release.index("  create-release:")
    assert validation < create
    create_job = release[create : release.index("\n  publish-release-assets:", create)]
    assert "- validate-release-package-set" in create_job


def test_linux_desktop_workflow_publishes_client_and_sidecar_rpms() -> None:
    desktop = (REPO_ROOT / ".github/workflows/tauri-desktop.yml").read_text(encoding="utf-8")

    assert "sudo apt-get install -y alien rpm" in desktop
    assert "node ./scripts/build-rpm-from-deb.mjs" in desktop
    assert "name: tauri-desktop-${{ matrix.upload_suffix }}-linux" in desktop
    upload_start = desktop.index("      - name: Upload Linux desktop package")
    upload_end = desktop.index("\n      - name: Upload Linux RPM package report", upload_start)
    assert "if: matrix.bundle_mode" not in desktop[upload_start:upload_end]


def test_python_package_metadata_points_to_the_canonical_repository() -> None:
    pyproject = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))

    assert pyproject["project"]["urls"] == {
        "Homepage": "https://github.com/joaojhgs/aurora",
        "Bug Reports": "https://github.com/joaojhgs/aurora/issues",
        "Source": "https://github.com/joaojhgs/aurora",
        "Documentation": "https://github.com/joaojhgs/aurora/blob/main/readme.md",
    }
    assert "main" in pyproject["tool"]["setuptools"]["py-modules"]


def test_portable_release_installs_the_pinned_browser_wasm_toolchain() -> None:
    release = (REPO_ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
    portable_start = release.index("  build-portable-packages:")
    portable_end = release.index("\n  build-desktop-packages:", portable_start)
    portable_job = release[portable_start:portable_end]

    rust_setup = portable_job.index("Set up Rust for browser voice runtime")
    tool_setup = portable_job.index("Install pinned browser voice toolchain")
    web_package = portable_job.index("pnpm --filter @aurora/web package:unsigned")

    assert "targets: wasm32-unknown-unknown" in portable_job
    assert "tool: wasm-bindgen-cli@0.2.126" in portable_job
    assert rust_setup < tool_setup < web_package


def test_only_canonical_workflow_owns_product_release_publication() -> None:
    release = (REPO_ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")

    assert "semantic-release" in release
    assert "gh release upload" in release
    assert "contents: write" in release
    for workflow in (REPO_ROOT / ".github/workflows").glob("*.yml"):
        if workflow.name in {
            "release.yml",
            "sherpa-pockettts-language-packs.yml",
        }:
            continue
        text = workflow.read_text(encoding="utf-8")
        assert "python-semantic-release" not in text, workflow.name
        assert "gh release upload" not in text, workflow.name


@pytest.mark.parametrize("workflow", PRIVILEGED_WORKFLOWS, ids=lambda path: path.stem)
def test_privileged_workflows_pin_external_actions_to_full_commit_shas(workflow: Path) -> None:
    text = workflow.read_text(encoding="utf-8")
    external_actions = re.findall(r"uses:\s+([^@\s]+)@([^\s#]+)", text)

    assert external_actions
    for action, revision in external_actions:
        if action.startswith("./"):
            continue
        assert re.fullmatch(r"[0-9a-f]{40}", revision), f"{workflow.name}: {action}@{revision}"


def test_docker_publication_is_only_callable_by_the_canonical_release() -> None:
    docker = (REPO_ROOT / ".github/workflows/docker-build.yml").read_text(encoding="utf-8")
    release = (REPO_ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")

    assert "workflow_call:" in docker
    assert "publish_images:" in docker
    assert "release_version:" in docker
    assert "if: inputs.publish_images == true" in docker
    assert 'tags:\n      - "v*.*.*"' not in docker
    assert "manual" not in docker
    assert release.count("uses: ./.github/workflows/docker-build.yml") == 2
    assert "publish_images: false" in release
    assert "publish_images: true" in release


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


def test_release_uses_the_exact_semantic_release_version_and_tag() -> None:
    release = (REPO_ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")

    assert "--as-prerelease --prerelease-token rc" in release
    assert "root_options:" not in release
    assert "semantic-release --strict version" in release
    assert 'tag="${{ needs.create-release.outputs.tag }}"' in release
    assert ('${{ needs.create-release.outputs.version }}" != "$expected_version') in release


def test_android_public_packages_are_release_mode_and_not_universal_debug() -> None:
    android = (REPO_ROOT / ".github/workflows/tauri-android.yml").read_text(encoding="utf-8")
    release = (REPO_ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")

    assert "Build Android client x86_64 debug APK for CI" in android
    assert "android:build:client:apk:arm64:release" in android
    assert "android:build:client:aab:release" in android
    assert "aurora-release-android-arm64-unsigned-apk" in android
    assert "aurora-release-android-unsigned-aab" in android
    assert "Build Android client universal debug APK for release" not in android
    assert "pattern: aurora-release-android-*" in release
    assert "aurora-android-client-debug-*" not in release


def test_release_version_script_updates_semver_and_android_code(
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
            str(REPO_ROOT / "scripts/set_release_version.mjs"),
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
    assert updated["bundle"]["windows"]["wix"]["version"] == "2.3.4.5"


def test_release_version_script_rejects_unrepresentable_versions(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "tauri.conf.json"
    original = '{"version":"1.0.0","bundle":{"android":{"versionCode":100}}}\\n'
    config_path.write_text(original, encoding="utf-8")
    result = subprocess.run(
        [
            "node",
            str(REPO_ROOT / "scripts/set_release_version.mjs"),
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


def test_release_version_script_synchronizes_every_package_surface(
    tmp_path: Path,
) -> None:
    copied_paths = [
        Path("VERSION"),
        Path("pyproject.toml"),
        Path("app/__init__.py"),
        Path("package.json"),
        Path("apps/aurora-tauri/src-tauri/tauri.conf.json"),
        Path("apps/aurora-tauri/src-tauri/Cargo.toml"),
        Path("apps/aurora-tauri/src-tauri/Cargo.lock"),
        Path("packages/aurora-ui/src/version.ts"),
        Path("packages/aurora-sdk/src/generated/backend-contracts.schema.json"),
        Path("packages/aurora-sdk/src/generated/backend-contracts.zod.ts"),
        Path("packages/aurora-sdk/src/generated/tooling-local-provider-v1.json"),
        Path("packages/aurora-sdk/src/generated/backend-contracts.manifest.json"),
        *(
            path.relative_to(REPO_ROOT)
            for parent in (REPO_ROOT / "apps", REPO_ROOT / "packages")
            for path in parent.glob("*/package.json")
        ),
    ]
    for relative_path in copied_paths:
        destination = tmp_path / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(REPO_ROOT / relative_path, destination)

    cargo_lock = tmp_path / "apps/aurora-tauri/src-tauri/Cargo.lock"
    cargo_lock.write_bytes(cargo_lock.read_bytes().replace(b"\n", b"\r\n"))

    result = subprocess.run(
        ["node", str(REPO_ROOT / "scripts/set_release_version.mjs"), "2.3.4"],
        cwd=REPO_ROOT,
        env={**os.environ, "AURORA_RELEASE_ROOT": str(tmp_path)},
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert (tmp_path / "VERSION").read_text(encoding="utf-8") == "2.3.4\n"
    with (tmp_path / "pyproject.toml").open("rb") as handle:
        assert tomllib.load(handle)["project"]["version"] == "2.3.4"
    assert '__version__ = "2.3.4"' in (tmp_path / "app/__init__.py").read_text(encoding="utf-8")
    for package_json in (path for path in copied_paths if path.name == "package.json"):
        assert (
            json.loads((tmp_path / package_json).read_text(encoding="utf-8"))["version"] == "2.3.4"
        )

    tauri_config = json.loads(
        (tmp_path / "apps/aurora-tauri/src-tauri/tauri.conf.json").read_text(encoding="utf-8")
    )
    assert tauri_config["version"] == "2.3.4"
    assert tauri_config["bundle"]["android"]["versionCode"] == 2_003_004
    assert tauri_config["bundle"]["windows"]["wix"]["version"] == "2.3.4.65535"
    assert re.search(
        r'\[package\][\s\S]*?version = "2\.3\.4"',
        (tmp_path / "apps/aurora-tauri/src-tauri/Cargo.toml").read_text(encoding="utf-8"),
    )
    assert 'name = "aurora-tauri"\nversion = "2.3.4"' in (
        tmp_path / "apps/aurora-tauri/src-tauri/Cargo.lock"
    ).read_text(encoding="utf-8")
    assert "AURORA_FALLBACK_VERSION = '2.3.4'" in (
        tmp_path / "packages/aurora-ui/src/version.ts"
    ).read_text(encoding="utf-8")

    generated_root = tmp_path / "packages/aurora-sdk/src/generated"
    schema = json.loads(
        (generated_root / "backend-contracts.schema.json").read_text(encoding="utf-8")
    )
    zod = (generated_root / "backend-contracts.zod.ts").read_text(encoding="utf-8")
    provider = json.loads(
        (generated_root / "tooling-local-provider-v1.json").read_text(encoding="utf-8")
    )
    manifest = json.loads(
        (generated_root / "backend-contracts.manifest.json").read_text(encoding="utf-8")
    )
    assert schema["contract_version"] == "2.3.4"
    assert 'AURORA_BACKEND_CONTRACT_VERSION = "2.3.4"' in zod

    def canonical_hash(value: object) -> str:
        payload = json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode()
        return hashlib.sha256(payload).hexdigest()

    expected_hashes = {
        "backend-contracts.schema.json": canonical_hash(schema),
        "backend-contracts.zod.ts": hashlib.sha256(zod.encode()).hexdigest(),
        "tooling-local-provider-v1.json": canonical_hash(provider),
    }
    assert manifest["content_hashes"] == expected_hashes
    assert manifest["final_checksum"] == canonical_hash(expected_hashes)
