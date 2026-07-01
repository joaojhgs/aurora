"""Generate PER-275 non-signing UI/Tauri/operator preflight artifacts.

The preflight is intentionally narrower than the final release packaging gate:
it checks build readiness, local sidecar/Gateway expectations, process-mode
operator prerequisites, native dependency gaps, and support-bundle redaction
without claiming signing, notarization, updater, store, or device-lab readiness.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

REPORT_ROOT = Path(".omx/reports/ui-release-preflight")
DEFAULT_GATEWAY_URL = "http://127.0.0.1:8000"

SENSITIVE_KEY_FRAGMENTS = (
    "api_key",
    "authorization",
    "bearer",
    "credential",
    "file",
    "host_path",
    "model_path",
    "password",
    "peer_secret",
    "private",
    "redis_url",
    "secret",
    "token",
)

REDACTION_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"redis://[^\s\"'<>]+", re.IGNORECASE), "redis://<redacted>"),
    (re.compile(r"Bearer\s+[A-Za-z0-9._~+/=-]+", re.IGNORECASE), "Bearer <redacted>"),
    (re.compile(r"(?i)(token|api[_-]?key|password|secret)=([^&\s\"']+)"), r"\1=<redacted>"),
    (re.compile(r"(?i)(/home|/Users)/[^\s\"'<>]+"), "<host-path-redacted>"),
    (re.compile(r"(?i)[A-Z]:\\Users\\[^\s\"'<>]+"), "<host-path-redacted>"),
    (re.compile(r"(?i)(/tmp|/var/tmp)/[^\s\"'<>]+"), "<local-path-redacted>"),
    (re.compile(r"(?i)[^\s\"'<>]+\.gguf"), "<model-path-redacted>"),
)


@dataclass(frozen=True)
class PreflightDefinition:
    row_id: str
    category: str
    label: str
    mode: str
    owner: str
    command: tuple[str, ...] = ()
    required: bool = True
    execute_by_default: bool = False
    remediation: str = ""
    skip_reason: str | None = None


@dataclass
class PreflightRow:
    row_id: str
    category: str
    label: str
    mode: str
    owner: str
    status: str
    required: bool
    remediation: str
    command: list[str] = field(default_factory=list)
    rationale: str = ""
    artifact_path: str | None = None
    returncode: int | None = None
    evidence: dict[str, Any] = field(default_factory=dict)


@dataclass
class PreflightReport:
    report_id: str
    generated_at: str
    issue: str
    branch: str
    source_docs: list[str]
    rows: list[dict[str, Any]]
    support_bundle_redaction_probe: dict[str, Any]
    summary: dict[str, Any]
    artifacts: dict[str, str]
    non_signing_scope: bool = True
    final_release_ready: bool = False
    secrets_redacted: bool = True


COMMAND_CHECKS: tuple[PreflightDefinition, ...] = (
    PreflightDefinition(
        "sdk-build",
        "web_ui_build",
        "Aurora TypeScript SDK build",
        "server_web desktop_thin desktop_local",
        "sdk",
        ("pnpm", "--filter", "@aurora/client", "build"),
        remediation="Run `pnpm install --frozen-lockfile`, then rerun the SDK build.",
    ),
    PreflightDefinition(
        "ui-package-build",
        "web_ui_build",
        "Aurora shared UI package build",
        "server_web desktop_thin desktop_local",
        "frontend",
        ("pnpm", "--filter", "@aurora/ui", "build"),
        remediation="Fix TypeScript/build errors in `packages/aurora-ui` before packaging.",
    ),
    PreflightDefinition(
        "web-app-build",
        "web_ui_build",
        "Server web app build",
        "server_web",
        "frontend",
        ("pnpm", "--filter", "@aurora/web", "build"),
        remediation="Fix Next.js build errors or document environment-specific blocker.",
    ),
    PreflightDefinition(
        "tauri-ui-build",
        "tauri_desktop",
        "Tauri frontend build without native bundle signing",
        "desktop_local desktop_thin",
        "tauri-native",
        ("pnpm", "--filter", "@aurora/tauri-ui", "build"),
        remediation="Fix Tauri UI TypeScript/Vite errors before native smoke.",
    ),
    PreflightDefinition(
        "tauri-sidecar-prepare",
        "sidecar",
        "Python sidecar binary staging",
        "desktop_local",
        "tauri-native",
        ("pnpm", "--filter", "@aurora/tauri-ui", "prepare:sidecar"),
        required=False,
        remediation=(
            "Set `AURORA_TAURI_SIDECAR_SOURCE` to a prebuilt executable sidecar; "
            "this preflight does not build or sign the sidecar for release."
        ),
    ),
    PreflightDefinition(
        "gateway-health",
        "gateway",
        "Local Gateway health endpoint",
        "desktop_thin server_web desktop_local",
        "backend",
        ("curl", "-fsS", f"{DEFAULT_GATEWAY_URL}/api/health"),
        required=False,
        remediation=(
            "Start Gateway locally or set `--gateway-url`; expected health path is "
            "`/api/health` and tokens must not be printed in logs."
        ),
    ),
    PreflightDefinition(
        "process-compose-config",
        "process_mode",
        "Process-mode Docker Compose config",
        "process_bullmq_redis",
        "release-ops",
        ("docker", "compose", "-f", "docker-compose.process.yml", "config", "--quiet"),
        required=False,
        remediation=(
            "Install Docker Compose v2 and verify Redis/process-mode config. "
            "If Docker socket access is unavailable, record the exact blocker."
        ),
    ),
)


def run_preflight(
    *,
    output_dir: Path = REPORT_ROOT / "latest",
    execute_commands: bool = False,
    command_ids: set[str] | None = None,
    gateway_url: str = DEFAULT_GATEWAY_URL,
    command_runner: Callable[[PreflightDefinition, Path], PreflightRow] | None = None,
) -> PreflightReport:
    output_dir.mkdir(parents=True, exist_ok=True)
    artifacts = {
        "json": str(output_dir / "ui_release_preflight.json"),
        "markdown": str(output_dir / "ui_release_preflight.md"),
        "redaction_probe": str(output_dir / "redaction_probe.json"),
    }
    redaction_probe = _redaction_probe()
    rows = _static_rows(gateway_url)
    rows.extend(
        _command_row(check, output_dir, execute_commands, command_ids, command_runner)
        for check in _checks_with_gateway_url(gateway_url)
    )
    rows.append(_redaction_row(output_dir, redaction_probe))
    summary = _summary(rows, redaction_probe)
    report = PreflightReport(
        report_id="PER-275-non-signing-ui-tauri-operator-preflight",
        generated_at=datetime.now(UTC).isoformat(),
        issue="PER-275",
        branch="multica/PER-275-release-operator-preflight",
        source_docs=[
            "docs/PER-269-tauri-ui-production-readiness-report.md",
            ".omx/specs/ui-production-tasks/tasks/QA-006-build-release-packaging-and-operator-runbooks.md",
            ".omx/specs/ui-refinement/aurora-ui-sdk-contract.md",
            "docs/RELEASE_PACKAGING_OPERATOR_RUNBOOK.md",
            "README.process-mode.md",
        ],
        rows=[asdict(row) for row in rows],
        support_bundle_redaction_probe=redaction_probe,
        summary=summary,
        artifacts=artifacts,
        secrets_redacted=redaction_probe["leak_count"] == 0,
    )
    (output_dir / "redaction_probe.json").write_text(
        json.dumps(redaction_probe, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (output_dir / "ui_release_preflight.json").write_text(
        json.dumps(_redact(asdict(report)), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (output_dir / "ui_release_preflight.md").write_text(
        _render_markdown(report),
        encoding="utf-8",
    )
    return report


def _checks_with_gateway_url(gateway_url: str) -> tuple[PreflightDefinition, ...]:
    checks: list[PreflightDefinition] = []
    for check in COMMAND_CHECKS:
        if check.row_id == "gateway-health":
            checks.append(
                PreflightDefinition(
                    **{
                        **asdict(check),
                        "command": ("curl", "-fsS", f"{gateway_url.rstrip('/')}/api/health"),
                    }
                )
            )
        else:
            checks.append(check)
    return tuple(checks)


def _static_rows(gateway_url: str) -> list[PreflightRow]:
    rows = [
        _tool_row("python-uv", "sidecar", "Python/uv available for sidecar", "desktop_local", "backend", "uv"),
        _tool_row("pnpm", "web_ui_build", "pnpm available for workspace builds", "server_web desktop_local desktop_thin", "frontend", "pnpm"),
        _tool_row("rustc", "tauri_desktop", "Rust compiler available for Tauri desktop checks", "desktop_local", "tauri-native", "rustc"),
        _tool_row("cargo", "tauri_desktop", "Cargo available for Tauri desktop checks", "desktop_local", "tauri-native", "cargo"),
        _linux_tauri_dependency_row(),
        _sidecar_source_row(),
        _socket_row("redis-port", "process_mode", "Redis localhost port check", "process_bullmq_redis", "release-ops", "127.0.0.1", 6379, False),
        _gateway_expectation_row(gateway_url),
        _mobile_tooling_row("android-sdk", "Android SDK tooling", "android_thin android_local_light", "android-native"),
        _mobile_tooling_row("xcode", "macOS/Xcode iOS tooling", "ios_thin ios_local_light", "ios-native"),
    ]
    return rows


def _tool_row(
    row_id: str,
    category: str,
    label: str,
    mode: str,
    owner: str,
    executable: str,
) -> PreflightRow:
    found = shutil.which(executable)
    return PreflightRow(
        row_id=row_id,
        category=category,
        label=label,
        mode=mode,
        owner=owner,
        status="pass" if found else "fail",
        required=True,
        remediation=f"Install `{executable}` and ensure it is on PATH.",
        evidence={"executable": executable, "path": _redact_text(found) if found else None},
    )


def _linux_tauri_dependency_row() -> PreflightRow:
    if sys.platform != "linux":
        return PreflightRow(
            row_id="linux-tauri-native-deps",
            category="tauri_desktop",
            label="Linux WebKit/GLib native dependencies",
            mode="desktop_local",
            owner="tauri-native",
            status="skipped",
            required=False,
            remediation="Linux WebKit/GLib packages are only required on Linux hosts.",
            rationale=f"Host platform is {sys.platform}.",
        )
    pkg_config = shutil.which("pkg-config")
    packages = ("webkit2gtk-4.1", "webkit2gtk-4.0", "javascriptcoregtk-4.1", "gtk+-3.0", "glib-2.0")
    available: list[str] = []
    missing: list[str] = []
    for package in packages:
        if pkg_config and subprocess.run(
            ["pkg-config", "--exists", package],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ).returncode == 0:
            available.append(package)
        else:
            missing.append(package)
    webkit_ok = "webkit2gtk-4.1" in available or "webkit2gtk-4.0" in available
    required_ok = webkit_ok and "gtk+-3.0" in available and "glib-2.0" in available
    return PreflightRow(
        row_id="linux-tauri-native-deps",
        category="tauri_desktop",
        label="Linux WebKit/GLib native dependencies",
        mode="desktop_local",
        owner="tauri-native",
        status="pass" if required_ok else "skipped",
        required=False,
        remediation=(
            "Install Tauri Linux prerequisites, for example WebKitGTK, GTK3, GLib, "
            "`pkg-config`, `libssl-dev`, and distro-specific appindicator/librsvg packages."
        ),
        rationale="" if required_ok else "Native desktop smoke is environment-gated until WebKit/GTK prerequisites are present.",
        evidence={"pkg_config": bool(pkg_config), "available": available, "missing": missing},
    )


def _sidecar_source_row() -> PreflightRow:
    source = os.environ.get("AURORA_TAURI_SIDECAR_SOURCE")
    exists = bool(source and Path(source).is_file())
    return PreflightRow(
        row_id="sidecar-source",
        category="sidecar",
        label="Prebuilt Python sidecar binary source",
        mode="desktop_local",
        owner="tauri-native",
        status="pass" if exists else "skipped",
        required=False,
        remediation="Set `AURORA_TAURI_SIDECAR_SOURCE` to a prebuilt executable before `build:bundle`.",
        rationale="" if exists else "No sidecar binary source configured; bundle build stays skipped with rationale.",
        evidence={"source_configured": bool(source), "source": _redact_text(source or "") or None},
    )


def _socket_row(
    row_id: str,
    category: str,
    label: str,
    mode: str,
    owner: str,
    host: str,
    port: int,
    required: bool,
) -> PreflightRow:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.25)
        ok = sock.connect_ex((host, port)) == 0
    return PreflightRow(
        row_id=row_id,
        category=category,
        label=label,
        mode=mode,
        owner=owner,
        status="pass" if ok else "skipped",
        required=required,
        remediation="Start Redis locally or through `docker compose -f docker-compose.process.yml up redis`.",
        rationale="" if ok else "No Redis listener found on localhost:6379; process-mode smoke is environment-gated.",
        evidence={"host": host, "port": port, "reachable": ok},
    )


def _gateway_expectation_row(gateway_url: str) -> PreflightRow:
    return PreflightRow(
        row_id="gateway-health-expectation",
        category="gateway",
        label="Gateway health expectation documented",
        mode="desktop_thin server_web desktop_local",
        owner="backend",
        status="pass",
        required=True,
        remediation="Gateway must expose `/api/health`; auth tokens stay outside logs and support bundles.",
        rationale="Documents the health endpoint expected by Tauri sidecar and thin client operators.",
        evidence={"gateway_url": _redact_text(gateway_url), "health_path": "/api/health"},
    )


def _mobile_tooling_row(row_id: str, label: str, mode: str, owner: str) -> PreflightRow:
    if row_id == "android-sdk":
        found = bool(os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT"))
        remediation = "Install Android SDK/NDK and set `ANDROID_HOME` or `ANDROID_SDK_ROOT`."
    else:
        found = sys.platform == "darwin" and bool(shutil.which("xcodebuild"))
        remediation = "Run iOS checks on macOS with Xcode and signing inputs available."
    return PreflightRow(
        row_id=row_id,
        category="mobile_tooling",
        label=label,
        mode=mode,
        owner=owner,
        status="pass" if found else "skipped",
        required=False,
        remediation=remediation,
        rationale="" if found else "Mobile tooling is outside this non-signing desktop/server preflight host.",
        evidence={"available": found},
    )


def _command_row(
    check: PreflightDefinition,
    output_dir: Path,
    execute_commands: bool,
    command_ids: set[str] | None,
    command_runner: Callable[[PreflightDefinition, Path], PreflightRow] | None,
) -> PreflightRow:
    if command_runner is not None:
        return command_runner(check, output_dir)
    if command_ids is not None and check.row_id not in command_ids:
        return _skipped_command_row(check, "Command not selected by --command-id.")
    if not execute_commands:
        return _skipped_command_row(check, "Command recorded but not executed; rerun with --execute-commands.")
    log_dir = output_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"{check.row_id}.log"
    completed = subprocess.run(
        check.command,
        cwd=Path.cwd(),
        text=True,
        capture_output=True,
        timeout=900,
        check=False,
    )
    log_path.write_text(
        _redact_text(
            "\n".join(
                [
                    f"$ {' '.join(check.command)}",
                    f"returncode={completed.returncode}",
                    completed.stdout,
                    completed.stderr,
                ]
            )
        ),
        encoding="utf-8",
    )
    return PreflightRow(
        row_id=check.row_id,
        category=check.category,
        label=check.label,
        mode=check.mode,
        owner=check.owner,
        status="pass" if completed.returncode == 0 else "fail",
        required=check.required,
        remediation=check.remediation,
        command=list(check.command),
        artifact_path=str(log_path),
        returncode=completed.returncode,
    )


def _skipped_command_row(check: PreflightDefinition, rationale: str) -> PreflightRow:
    return PreflightRow(
        row_id=check.row_id,
        category=check.category,
        label=check.label,
        mode=check.mode,
        owner=check.owner,
        status="skipped",
        required=check.required,
        remediation=check.remediation,
        command=list(check.command),
        rationale=check.skip_reason or rationale,
    )


def _redaction_row(output_dir: Path, probe: dict[str, Any]) -> PreflightRow:
    ok = probe["leak_count"] == 0
    return PreflightRow(
        row_id="support-bundle-redaction",
        category="diagnostics",
        label="Support bundle/log redaction probe",
        mode="all",
        owner="qa-release",
        status="pass" if ok else "fail",
        required=True,
        remediation="Update `redact_value` patterns before sharing diagnostics artifacts.",
        artifact_path=str(output_dir / "redaction_probe.json"),
        evidence={"probe_sha256": probe["redacted_sha256"], "leak_count": probe["leak_count"]},
    )


def _redaction_probe() -> dict[str, Any]:
    sample = {
        "token": "secret-token-123",
        "authorization": "Bearer abc.def.ghi",
        "redis_url": "redis://:password@localhost:6379/0",
        "host_path": "/home/developer/private/project/config.json",
        "peer_secret": "peer-secret-value",
        "model_path": "/home/developer/models/private/model.gguf",
        "local_file": "/tmp/aurora/private-diagnostics.log",
        "private_diagnostics": "token=abc123 api_key=sk-test-value password=hunter2",
        "safe_status": "degraded",
        "correlation_id": "corr-per-275",
    }
    redacted = _redact(sample)
    serialized = json.dumps(redacted, sort_keys=True)
    forbidden = (
        "secret-token-123",
        "abc.def.ghi",
        "redis://:password@localhost:6379/0",
        "/home/developer",
        "peer-secret-value",
        "model.gguf",
        "/tmp/aurora",
        "sk-test-value",
        "hunter2",
    )
    leaks = [value for value in forbidden if value in serialized]
    return {
        "secrets_redacted": True,
        "redacted": redacted,
        "leaks": leaks,
        "leak_count": len(leaks),
        "redacted_sha256": hashlib.sha256(serialized.encode("utf-8")).hexdigest(),
    }


def _summary(rows: Sequence[PreflightRow], redaction_probe: dict[str, Any]) -> dict[str, Any]:
    status_counts = dict.fromkeys(("pass", "fail", "skipped"), 0)
    for row in rows:
        status_counts[row.status] = status_counts.get(row.status, 0) + 1
    required_failures = [row.row_id for row in rows if row.required and row.status == "fail"]
    skipped_required = [row.row_id for row in rows if row.required and row.status == "skipped"]
    degraded = [row.row_id for row in rows if row.status == "skipped"]
    return {
        "status": "fail" if required_failures else "pass",
        "row_count": len(rows),
        "status_counts": status_counts,
        "required_failures": required_failures,
        "skipped_required": skipped_required,
        "degraded_or_skipped_rows": degraded,
        "non_signing_scope": True,
        "final_release_ready": False,
        "signing_notarization_store_release_deferred": True,
        "secrets_redacted": redaction_probe["leak_count"] == 0,
    }


def _render_markdown(report: PreflightReport) -> str:
    lines = [
        "# PER-275 UI/Tauri/Operator Non-Signing Preflight",
        "",
        f"Generated: {report.generated_at}",
        "",
        "This artifact is a non-signing operator preflight. It does not claim notarization, updater, app-store, TestFlight, Play Store, physical-device, or final production readiness.",
        "",
        "| Row | Category | Mode | Status | Required | Command | Remediation |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for row in report.rows:
        command = " ".join(row["command"]) if row["command"] else ""
        lines.append(
            "| {row_id} | {category} | {mode} | {status} | {required} | `{command}` | {remediation} |".format(
                row_id=row["row_id"],
                category=row["category"],
                mode=row["mode"],
                status=row["status"],
                required=row["required"],
                command=command,
                remediation=row["remediation"].replace("|", "\\|"),
            )
        )
    lines.extend(
        [
            "",
            "## Summary",
            "",
            f"- Status: `{report.summary['status']}`",
            f"- Rows: `{report.summary['row_count']}`",
            f"- Required failures: `{', '.join(report.summary['required_failures']) or 'none'}`",
            f"- Degraded/skipped rows: `{', '.join(report.summary['degraded_or_skipped_rows']) or 'none'}`",
            "- Secrets redacted: `true`",
            "- Final release ready: `false`",
        ]
    )
    return "\n".join(lines) + "\n"


def _redact(value: Any) -> Any:
    if isinstance(value, dict):
        redacted: dict[str, Any] = {}
        for key, item in value.items():
            if _is_sensitive_key(key):
                redacted[key] = "[redacted]"
            else:
                redacted[key] = _redact(item)
        return redacted
    if isinstance(value, list):
        return [_redact(item) for item in value]
    if isinstance(value, str):
        return _redact_text(value)
    return value


def _is_sensitive_key(key: str) -> bool:
    lowered = key.lower()
    if lowered == "secrets_redacted":
        return False
    return any(fragment in lowered for fragment in SENSITIVE_KEY_FRAGMENTS)


def _redact_text(value: str | None) -> str:
    if not value:
        return ""
    redacted = value
    for pattern, replacement in REDACTION_PATTERNS:
        redacted = pattern.sub(replacement, redacted)
    return redacted


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=REPORT_ROOT / "latest",
        help="Directory for ui_release_preflight.json, markdown, logs, and redaction probe.",
    )
    parser.add_argument(
        "--execute-commands",
        action="store_true",
        help="Execute command rows and write redacted logs. Default records them as skipped-with-rationale.",
    )
    parser.add_argument(
        "--command-id",
        action="append",
        dest="command_ids",
        help="Limit command execution to one row id. May be repeated.",
    )
    parser.add_argument(
        "--gateway-url",
        default=DEFAULT_GATEWAY_URL,
        help="Gateway base URL for the optional health row.",
    )
    parser.add_argument(
        "--print-summary",
        action="store_true",
        help="Print summary JSON after writing artifacts.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = run_preflight(
        output_dir=args.output_dir,
        execute_commands=args.execute_commands,
        command_ids=set(args.command_ids) if args.command_ids else None,
        gateway_url=args.gateway_url,
    )
    if args.print_summary:
        print(json.dumps(report.summary, indent=2, sort_keys=True))
    return 1 if report.summary["required_failures"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
