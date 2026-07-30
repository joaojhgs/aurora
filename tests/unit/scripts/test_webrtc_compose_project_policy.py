from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]


def read_repo(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


def default_compose_project(source: str) -> str:
    match = re.search(
        r'COMPOSE_PROJECT_NAME="\$\{COMPOSE_PROJECT_NAME:-(?P<name>[^}]+)\}"',
        source,
    )
    assert match is not None
    return match.group("name")


def assert_compose_project_name_is_valid(name: str) -> None:
    assert re.fullmatch(r"[a-z0-9][a-z0-9_-]*", name)


def test_webrtc_services_uses_explicit_stable_compose_project() -> None:
    source = read_repo("scripts/webrtc_interop_services.sh")

    assert default_compose_project(source) == "aurora-webrtc-interop"
    assert 'docker compose -p "$COMPOSE_PROJECT_NAME"' in source
    assert "docker compose -f docker-compose.webrtc-interop.yml" not in source


def test_live_harnesses_have_distinct_valid_default_compose_projects() -> None:
    script_paths = [
        "scripts/desktop_live_e2e.sh",
        "scripts/hosted_peer_e2e.sh",
        "scripts/hosted_mesh_node_e2e.sh",
        "scripts/hosted_thin_shell_e2e.sh",
        "scripts/webrtc_interop_local.sh",
        "scripts/webrtc_interop_browser_matrix.sh",
    ]

    defaults = {
        script_path: default_compose_project(read_repo(script_path))
        for script_path in script_paths
    }

    assert defaults == {
        "scripts/desktop_live_e2e.sh": "aurora-desktop-live-e2e",
        "scripts/hosted_peer_e2e.sh": "aurora-hosted-peer-e2e",
        "scripts/hosted_mesh_node_e2e.sh": "aurora-hosted-mesh-node-e2e",
        "scripts/hosted_thin_shell_e2e.sh": "aurora-hosted-thin-e2e",
        "scripts/webrtc_interop_local.sh": "aurora-webrtc-interop-local",
        "scripts/webrtc_interop_browser_matrix.sh": "aurora-webrtc-browser-matrix",
    }
    assert len(set(defaults.values())) == len(defaults)
    for name in defaults.values():
        assert_compose_project_name_is_valid(name)


def test_callers_preserve_existing_compose_project_override() -> None:
    for script_path in [
        "scripts/desktop_live_e2e.sh",
        "scripts/hosted_peer_e2e.sh",
        "scripts/hosted_mesh_node_e2e.sh",
        "scripts/hosted_thin_shell_e2e.sh",
        "scripts/webrtc_interop_local.sh",
        "scripts/webrtc_interop_browser_matrix.sh",
        "scripts/webrtc_interop_services.sh",
    ]:
        source = read_repo(script_path)
        assert 'COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-' in source


def test_desktop_node_harness_sets_same_default_when_run_directly() -> None:
    source = read_repo("tests/e2e/desktop_live/desktop-live-e2e.mjs")

    assert "process.env.COMPOSE_PROJECT_NAME ??= 'aurora-desktop-live-e2e'" in source
