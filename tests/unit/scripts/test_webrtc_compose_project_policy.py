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


def node_default_compose_project(source: str) -> str:
    match = re.search(
        r"process\.env\.COMPOSE_PROJECT_NAME \|\|= '(?P<name>[^']+)'",
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


def test_webrtc_services_can_reuse_externally_managed_local_services() -> None:
    source = read_repo("scripts/webrtc_interop_services.sh")

    assert "AURORA_WEBRTC_INTEROP_SERVICES_EXTERNAL:-0" in source
    assert 'if [[ "$EXTERNAL_SERVICES" != "1" ]]; then' in source
    assert source.count("wait_for_tcp webrtc-interop-") == 2
    assert 'echo "WebRTC interop services are externally managed"' in source


def test_webrtc_browser_runner_has_a_separate_overridable_total_timeout() -> None:
    source = read_repo("scripts/webrtc_interop.sh")

    assert 'TIMEOUT_SECONDS="${WEBRTC_INTEROP_TIMEOUT_SECONDS:-120}"' in source
    assert '--timeout "$TIMEOUT_SECONDS"' in source


def test_hosted_browser_harnesses_build_voice_package_before_web_ui() -> None:
    for script_path in (
        "scripts/hosted_peer_e2e.sh",
        "scripts/hosted_mesh_node_e2e.sh",
    ):
        source = read_repo(script_path)
        voice_build = source.index("pnpm --filter @aurora/voice-web build")
        web_build = source.index("pnpm --filter @aurora/web build")
        web_start = source.index('node "$WEB_STANDALONE_DIR/server.js"')
        assert voice_build < web_start, script_path
        assert voice_build < web_build < web_start, script_path


def test_hosted_browser_harnesses_use_the_production_web_server() -> None:
    for script_path in (
        "scripts/hosted_peer_e2e.sh",
        "scripts/hosted_mesh_node_e2e.sh",
    ):
        source = read_repo(script_path)

        assert "next dev" not in source, script_path
        assert "next start" not in source, script_path
        assert re.search(
            r"NEXT_PUBLIC_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK=1 \\\n"
            r"\s+pnpm --filter @aurora/web build",
            source,
        ), script_path
        assert 'node "$WEB_STANDALONE_DIR/server.js"' in source, script_path
        assert 'HOSTNAME=127.0.0.1 \\' in source, script_path
        assert 'PORT="$WEB_PORT" \\' in source, script_path
        assert 'cp -R "$ROOT/apps/aurora-web/.next/static/."' in source, script_path
        assert 'cp -R "$ROOT/apps/aurora-web/public/."' in source, script_path


def test_hosted_browser_harnesses_bound_http_readiness_probes() -> None:
    for script_path in (
        "scripts/hosted_peer_e2e.sh",
        "scripts/hosted_mesh_node_e2e.sh",
    ):
        source = read_repo(script_path)

        assert (
            'HTTP_READY_TIMEOUT_SECONDS="${AURORA_LIVE_HTTP_READY_TIMEOUT_SECONDS:-180}"' in source
        )
        assert "curl --connect-timeout 1 --max-time 5 -fsS" in source
        assert source.count("wait_for_http \\") == 2
        assert 'curl -fsS "http://127.0.0.1:' not in source


def test_live_harnesses_have_distinct_valid_default_compose_projects() -> None:
    shell_script_paths = [
        "scripts/desktop_live_e2e.sh",
        "scripts/hosted_peer_e2e.sh",
        "scripts/hosted_mesh_node_e2e.sh",
        "scripts/hosted_thin_shell_e2e.sh",
        "scripts/webrtc_interop_local.sh",
        "scripts/webrtc_interop_browser_matrix.sh",
    ]
    node_caller_paths = [
        "tests/e2e/desktop_live/desktop-live-e2e.mjs",
        "apps/aurora-tauri/tests/android/android-python-webrtc.e2e.test.ts",
        "apps/aurora-tauri/tests/android/android-browser-python-webrtc.e2e.test.ts",
    ]

    defaults = {
        script_path: default_compose_project(read_repo(script_path))
        for script_path in shell_script_paths
    } | {
        caller_path: node_default_compose_project(read_repo(caller_path))
        for caller_path in node_caller_paths
    }

    assert defaults == {
        "scripts/desktop_live_e2e.sh": "aurora-desktop-live-e2e",
        "scripts/hosted_peer_e2e.sh": "aurora-hosted-peer-e2e",
        "scripts/hosted_mesh_node_e2e.sh": "aurora-hosted-mesh-node-e2e",
        "scripts/hosted_thin_shell_e2e.sh": "aurora-hosted-thin-e2e",
        "scripts/webrtc_interop_local.sh": "aurora-webrtc-interop-local",
        "scripts/webrtc_interop_browser_matrix.sh": "aurora-webrtc-browser-matrix",
        "tests/e2e/desktop_live/desktop-live-e2e.mjs": "aurora-desktop-live-e2e",
        "apps/aurora-tauri/tests/android/android-python-webrtc.e2e.test.ts": (
            "aurora-android-webview-webrtc-e2e"
        ),
        "apps/aurora-tauri/tests/android/android-browser-python-webrtc.e2e.test.ts": (
            "aurora-android-mobile-webrtc-e2e"
        ),
    }
    lifecycle_defaults = {
        "desktop-live": defaults["scripts/desktop_live_e2e.sh"],
        "hosted-peer": defaults["scripts/hosted_peer_e2e.sh"],
        "hosted-mesh-node": defaults["scripts/hosted_mesh_node_e2e.sh"],
        "hosted-thin": defaults["scripts/hosted_thin_shell_e2e.sh"],
        "webrtc-local": defaults["scripts/webrtc_interop_local.sh"],
        "webrtc-browser-matrix": defaults["scripts/webrtc_interop_browser_matrix.sh"],
        "android-webview": defaults[
            "apps/aurora-tauri/tests/android/android-python-webrtc.e2e.test.ts"
        ],
        "android-mobile": defaults[
            "apps/aurora-tauri/tests/android/android-browser-python-webrtc.e2e.test.ts"
        ],
    }

    assert (
        defaults["tests/e2e/desktop_live/desktop-live-e2e.mjs"]
        == lifecycle_defaults["desktop-live"]
    )
    assert len(set(lifecycle_defaults.values())) == len(lifecycle_defaults)
    for name in lifecycle_defaults.values():
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

    assert "process.env.COMPOSE_PROJECT_NAME ||= 'aurora-desktop-live-e2e'" in source


def test_android_node_harnesses_set_caller_specific_defaults() -> None:
    android_webview = read_repo("apps/aurora-tauri/tests/android/android-python-webrtc.e2e.test.ts")
    android_mobile = read_repo(
        "apps/aurora-tauri/tests/android/android-browser-python-webrtc.e2e.test.ts"
    )

    assert (
        "process.env.COMPOSE_PROJECT_NAME ||= 'aurora-android-webview-webrtc-e2e'"
        in android_webview
    )
    assert (
        "process.env.COMPOSE_PROJECT_NAME ||= 'aurora-android-mobile-webrtc-e2e'" in android_mobile
    )


def test_webrtc_interop_compose_binds_loopback_and_omits_mqtt_tcp() -> None:
    source = read_repo("docker-compose.webrtc-interop.yml")

    # MQTT is only ever dialled at 127.0.0.1, so it stays loopback-bound and
    # the plaintext TCP listener stays gone.
    assert '"127.0.0.1:9001:9001"' in source
    assert "1883" not in source
    # coturn must stay reachable off-loopback: scripts/webrtc_interop.sh dials
    # stun:<host-ipv4>:3478 for the stun lane and for Firefox on the turn lane.
    assert '"3478:3478/udp"' in source
    assert '"3478:3478/tcp"' in source
    assert '"127.0.0.1:3478' not in source
    assert "cli-ip=127.0.0.1" in source
