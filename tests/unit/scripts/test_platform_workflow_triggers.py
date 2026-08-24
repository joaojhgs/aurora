from __future__ import annotations

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


@pytest.mark.parametrize("workflow", MOBILE_WORKFLOWS, ids=lambda path: path.stem)
def test_mobile_workflows_run_for_backend_webrtc_contract_changes(workflow: Path) -> None:
    text = workflow.read_text(encoding="utf-8")

    for trigger_path in MOBILE_WEBRTC_TRIGGER_PATHS:
        assert f'- "{trigger_path}"' in text


def test_frontend_workflow_builds_mesh_authority_before_sdk_tests() -> None:
    text = (REPO_ROOT / ".github/workflows/frontend-sdk.yml").read_text(encoding="utf-8")

    authority_build = text.index("pnpm --filter @aurora/mesh-authority-web build")
    sdk_test = text.index("pnpm --filter @aurora/client test:coverage")
    assert authority_build < sdk_test
