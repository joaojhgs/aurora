"""Generate PER-227 release packaging and operator runbook artifacts.

The QA-006 gate is intentionally evidence-oriented. It records the platform
packaging commands, required logs, accepted skips, owners, security/privacy
negative gates, and install/update/backup/diagnostics/rollback operator steps
required before Aurora can claim production release readiness.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

REPORT_ROOT = Path(".omx/reports/release-packaging-operator")


@dataclass(frozen=True)
class PackagingCommand:
    """One command or workflow that contributes package evidence."""

    command_id: str
    platform: str
    command: str
    workflow: str
    artifact: str
    log_artifact: str
    owner: str
    required_for_release: bool = True
    manual: bool = False
    skip_reason: str | None = None


@dataclass(frozen=True)
class PlatformReleaseRow:
    """One platform/package release gate row."""

    row_id: str
    label: str
    support_code: str
    owner: str
    modes: tuple[str, ...]
    commands: tuple[PackagingCommand, ...]
    required_upstream_gates: tuple[str, ...]
    release_blockers: tuple[str, ...] = ()
    notes: tuple[str, ...] = ()


@dataclass(frozen=True)
class OperatorRunbookSection:
    """One operator runbook section required by QA-006."""

    section_id: str
    title: str
    owner: str
    steps: tuple[str, ...]
    required_artifact: str


@dataclass(frozen=True)
class NegativeGate:
    """Security/privacy or release-safety negative gate."""

    gate_id: str
    category: str
    assertion: str
    proving_artifact: str
    owner: str
    source_task_ids: tuple[str, ...]


@dataclass
class ReleasePackagingReport:
    """Serializable top-level PER-227 gate report."""

    report_id: str
    generated_at: str
    issue: str
    branch: str
    source_docs: list[str]
    platform_rows: list[dict[str, Any]]
    negative_gates: list[dict[str, Any]]
    runbook_sections: list[dict[str, Any]]
    final_readiness_checklist: list[dict[str, Any]]
    summary: dict[str, Any]
    artifacts: dict[str, str]
    secrets_redacted: bool = True


PLATFORM_ROWS: tuple[PlatformReleaseRow, ...] = (
    PlatformReleaseRow(
        "python-server",
        "Python package and process-mode services",
        "supported",
        "release-ops",
        ("thread_localbus", "process_bullmq_redis", "server_web"),
        (
            PackagingCommand(
                "python-wheel",
                "linux",
                "python scripts/build.py --target wheel --clean",
                ".github/workflows/release.yml#validate",
                "dist/*.whl and dist/*.tar.gz",
                ".omx/reports/release-packaging-operator/latest/python-wheel.log",
                "release-ops",
            ),
            PackagingCommand(
                "docker-process-services",
                "linux",
                "make docker-process-mode",
                ".github/workflows/release.yml#docker-build",
                "Docker service image digests for config/auth/gateway/db/orchestrator/tooling/scheduler/audio services",
                ".omx/reports/release-packaging-operator/latest/docker-process-services.log",
                "release-ops",
            ),
        ),
        ("QA-001", "QA-002", "QA-003", "QA-005", "QA-008"),
        notes=(
            "Process-mode release evidence must include Redis/BullMQ health or a dependency-gap skip.",
        ),
    ),
    PlatformReleaseRow(
        "desktop-tauri",
        "Tauri desktop local package, sidecar, and updater",
        "partial",
        "tauri-native",
        ("desktop_local", "desktop_thin", "tauri_local_native"),
        (
            PackagingCommand(
                "desktop-sidecar",
                "linux/windows/macos",
                "pnpm --filter @aurora/tauri-ui prepare:sidecar",
                ".github/workflows/tauri-desktop.yml#linux-tauri",
                "apps/aurora-tauri/reports/qa-005-sidecar-smoke.log",
                "apps/aurora-tauri/reports/qa-005-sidecar-smoke.log",
                "tauri-native",
            ),
            PackagingCommand(
                "desktop-bundle",
                "linux/windows/macos",
                "pnpm --filter @aurora/tauri-ui build:bundle",
                ".github/workflows/tauri-desktop.yml#linux-tauri plus release runners for Windows/macOS",
                "Tauri AppImage/deb/rpm/dmg/msi/nsis bundles and updater manifests",
                ".omx/reports/release-packaging-operator/latest/desktop-bundle.log",
                "tauri-native",
            ),
        ),
        ("TAURI-006", "QA-004", "QA-005"),
        release_blockers=(
            "Final production desktop release still needs signed Windows/macOS artifacts and updater endpoint verification from release runners.",
        ),
    ),
    PlatformReleaseRow(
        "android-tauri",
        "Android APK/AAB, signing, and assistant-role device matrix",
        "partial",
        "android-native",
        ("android_thin", "android_local_light"),
        (
            PackagingCommand(
                "android-emulator-apk",
                "android",
                "pnpm --filter @aurora/tauri-ui android:build:apk:x86_64:debug && pnpm --filter @aurora/tauri-ui android:smoke",
                ".github/workflows/tauri-android.yml#android-tauri",
                "aurora-tauri-android-apk and emulator smoke logs",
                ".omx/reports/release-packaging-operator/latest/android-emulator.log",
                "android-native",
            ),
            PackagingCommand(
                "android-signed-release",
                "android",
                "pnpm --filter @aurora/tauri-ui android:release-gate:strict && pnpm --filter @aurora/tauri-ui android:build:aab",
                "manual-device-lab/android",
                "signed Android App Bundle, Play upload receipt, and physical/OEM assistant-role matrix",
                "device-lab/android-assistant-role-and-oem-matrix.md",
                "android-native",
                manual=True,
                skip_reason="Emulator-only CI cannot prove production assistant-role behavior.",
            ),
        ),
        ("AND-009", "QA-002", "QA-003"),
        release_blockers=(
            "Physical/OEM assistant-role matrix is required before Android production-complete status.",
        ),
    ),
    PlatformReleaseRow(
        "ios-tauri",
        "iOS App Store/TestFlight package and app-owned integration matrix",
        "partial",
        "ios-native",
        ("ios_thin", "ios_local_light"),
        (
            PackagingCommand(
                "ios-policy",
                "ios",
                "pnpm --filter @aurora/tauri-ui ios:policy",
                ".github/workflows/tauri-ios-release.yml#ios-policy",
                "iOS release gate policy log",
                ".omx/reports/release-packaging-operator/latest/ios-policy.log",
                "ios-native",
            ),
            PackagingCommand(
                "ios-app-store-dry-run",
                "ios",
                "pnpm --filter @aurora/tauri-ui ios:build:app-store",
                ".github/workflows/tauri-ios-release.yml#ios-macos-xcode",
                "IPA, App Store Connect dry-run/upload evidence, and TestFlight real-device matrix",
                "device-lab/ios-testflight-real-device-matrix.md",
                "ios-native",
                manual=True,
                skip_reason="Simulator-only CI cannot prove real-device/TestFlight behavior.",
            ),
        ),
        ("IOS-008", "QA-002", "QA-003"),
        release_blockers=(
            "Real-device/TestFlight matrix is required before iOS production-complete status.",
        ),
        notes=("iOS must not claim default-assistant or Siri replacement behavior.",),
    ),
)


NEGATIVE_GATES: tuple[NegativeGate, ...] = (
    NegativeGate(
        "security-privacy-negative-suite",
        "security_privacy",
        "QA-003 negative cases pass before release packaging can be promoted.",
        ".omx/reports/security-privacy-regression/latest/security_privacy_gate.json",
        "qa-release",
        ("QA-003",),
    ),
    NegativeGate(
        "mock-transport-not-release-proof",
        "release_safety",
        "Mock transport and fixture-only evidence are rejected as production release proof.",
        ".omx/reports/multi-mode-e2e/latest/matrix.json",
        "qa-release",
        ("QA-002", "SDK-014"),
    ),
    NegativeGate(
        "emulator-only-mobile-not-production-complete",
        "release_safety",
        "Android emulator and iOS simulator evidence stay partial until physical/TestFlight matrices are attached.",
        "device-lab/android-assistant-role-and-oem-matrix.md and device-lab/ios-testflight-real-device-matrix.md",
        "release-ops",
        ("AND-009", "IOS-008", "QA-006"),
    ),
    NegativeGate(
        "diagnostics-redaction-required",
        "credential",
        "Diagnostics bundles must omit raw tokens, Redis URLs, host paths, raw audio, and raw RAG records.",
        ".omx/reports/mesh-gap-e2e/latest/support_bundle.json",
        "qa-release",
        ("ADM-009", "QA-003", "QA-006"),
    ),
)


RUNBOOK_SECTIONS: tuple[OperatorRunbookSection, ...] = (
    OperatorRunbookSection(
        "install",
        "Install",
        "release-ops",
        (
            "Install Python dependencies with `uv sync --extra test-e2e --extra gateway --extra mode-processes`.",
            "Install frontend/native dependencies with `pnpm install --frozen-lockfile`.",
            "Install platform prerequisites before native packaging: Tauri Linux WebKit packages, Windows Edge WebDriver/signing tooling, macOS Xcode, Android SDK/NDK, or Apple signing tools as applicable.",
        ),
        "dependency installation logs and platform prerequisite summary",
    ),
    OperatorRunbookSection(
        "update",
        "Update",
        "release-ops",
        (
            "Build Python/server artifacts, Docker process-mode images, Tauri desktop bundles, Android APK/AAB, and iOS IPA/TestFlight artifacts for the target release candidate.",
            "Attach version, commit SHA, package checksums, signing/notarization/upload receipts, updater manifest, and smoke logs.",
            "Run QA-001 through QA-006 gates and record every skipped row with owner and accepted rationale.",
        ),
        ".omx/reports/release-packaging-operator/latest/release_packaging_gate.json",
    ),
    OperatorRunbookSection(
        "backup",
        "Backup",
        "release-ops",
        (
            "Create AdminAction-gated backups for config, DB/RAG, and model/runtime inventory before upgrade.",
            "Record provenance, namespace, retention, and redaction policy for each backup artifact.",
            "Run restore rehearsal on an isolated profile before promoting the release candidate.",
        ),
        "backup manifest, restore rehearsal log, and AdminAction audit receipt",
    ),
    OperatorRunbookSection(
        "diagnostics",
        "Diagnostics",
        "qa-release",
        (
            "Generate QA-002, QA-003, QA-004, QA-005, QA-006, and mesh support-bundle artifacts.",
            "Attach Gateway/Auth/Config/Supervisor/Mesh/Orchestrator/Tooling evidence only through public SDK or documented release commands.",
            "Verify `secrets_redacted=true` and correlation IDs for failures before sharing support bundles.",
        ),
        ".omx/reports/release-packaging-operator/latest/runbook.md",
    ),
    OperatorRunbookSection(
        "rollback",
        "Rollback",
        "release-ops",
        (
            "Select the previous release whose QA-001 through QA-006 artifacts are complete for the affected platform.",
            "Restore the previous package/sidecar/web deployment and updater manifest; restore config/data only after AdminAction confirmation.",
            "Rerun package smoke, security/privacy smoke, diagnostics bundle generation, and restore checks before declaring rollback complete.",
        ),
        "rollback checklist, restored package checksums, restore audit receipt, and redacted diagnostics bundle",
    ),
)


def build_report(output_dir: Path) -> ReleasePackagingReport:
    """Build and persist the PER-227 release packaging gate artifacts."""

    output_dir.mkdir(parents=True, exist_ok=True)
    artifacts = {
        "json": str(output_dir / "release_packaging_gate.json"),
        "markdown": str(output_dir / "release_packaging_gate.md"),
        "runbook": str(output_dir / "runbook.md"),
    }
    manual_items = [
        command
        for row in PLATFORM_ROWS
        for command in row.commands
        if command.manual
    ]
    release_blockers = [
        blocker
        for row in PLATFORM_ROWS
        for blocker in row.release_blockers
    ]
    report = ReleasePackagingReport(
        report_id="PER-227-QA-006-release-packaging-operator-runbooks",
        generated_at=datetime.now(UTC).isoformat(),
        issue="PER-227",
        branch="multica/QA-006-release-packaging-operator-runbooks",
        source_docs=[
            ".omx/specs/ui-production-tasks/tasks/QA-006-build-release-packaging-and-operator-runbooks.md",
            "docs/MULTI_MODE_E2E_RELEASE_RUNBOOK.md",
            "docs/SECURITY_PRIVACY_REGRESSION_RUNBOOK.md",
            "docs/QA-005_PERFORMANCE_OFFLINE_RESILIENCE_RUNBOOK.md",
            ".omx/specs/ui-refinement/aurora-ui-sdk-contract.md",
        ],
        platform_rows=[asdict(row) for row in PLATFORM_ROWS],
        negative_gates=[asdict(gate) for gate in NEGATIVE_GATES],
        runbook_sections=[asdict(section) for section in RUNBOOK_SECTIONS],
        final_readiness_checklist=_readiness_checklist(release_blockers),
        summary={
            "platform_count": len(PLATFORM_ROWS),
            "platforms": [row.row_id for row in PLATFORM_ROWS],
            "required_commands": [
                command.command_id for row in PLATFORM_ROWS for command in row.commands
            ],
            "manual_device_lab_items": [command.command_id for command in manual_items],
            "accepted_skips": {
                command.command_id: command.skip_reason
                for command in manual_items
                if command.skip_reason
            },
            "release_blockers": release_blockers,
            "runbook_sections": [section.section_id for section in RUNBOOK_SECTIONS],
            "negative_gate_count": len(NEGATIVE_GATES),
            "mock_transport_release_evidence_allowed": False,
            "production_complete": not release_blockers,
        },
        artifacts=artifacts,
    )
    (output_dir / "release_packaging_gate.json").write_text(
        json.dumps(asdict(report), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (output_dir / "release_packaging_gate.md").write_text(
        _render_gate_markdown(report),
        encoding="utf-8",
    )
    (output_dir / "runbook.md").write_text(_render_runbook_markdown(report), encoding="utf-8")
    return report


def _readiness_checklist(release_blockers: list[str]) -> list[dict[str, Any]]:
    return [
        {
            "task_id": "QA-001",
            "requirement": "SDK/backend contract conformance CI is green.",
            "artifact": ".github/workflows/sdk-backend-contract-conformance.yml",
            "status": "required",
        },
        {
            "task_id": "QA-002",
            "requirement": "Multi-mode E2E matrix is generated and release blockers are understood.",
            "artifact": ".omx/reports/multi-mode-e2e/latest/matrix.json",
            "status": "required",
        },
        {
            "task_id": "QA-003",
            "requirement": "Security/privacy negative cases pass before packaging promotion.",
            "artifact": ".omx/reports/security-privacy-regression/latest/security_privacy_gate.json",
            "status": "required",
        },
        {
            "task_id": "QA-004",
            "requirement": "Screen-level accessibility, responsive, and visual evidence is attached.",
            "artifact": "docs/QA-004-accessibility-responsive-visual-runbook.md",
            "status": "required",
        },
        {
            "task_id": "QA-005",
            "requirement": "Performance, offline, resilience, and Tauri sidecar smoke evidence is attached.",
            "artifact": "docs/QA-005_PERFORMANCE_OFFLINE_RESILIENCE_RUNBOOK.md",
            "status": "required",
        },
        {
            "task_id": "QA-006",
            "requirement": "Release packaging gate records commands, logs, platforms, skipped tests, owners, and operator runbook sections.",
            "artifact": ".omx/reports/release-packaging-operator/latest/release_packaging_gate.json",
            "status": "covered",
        },
        {
            "task_id": "QA-007",
            "requirement": "Final readiness audit consumes QA-001 through QA-006 artifacts.",
            "artifact": ".omx/specs/ui-production-tasks/tasks/QA-007-final-production-readiness-audit-and-task-board-closure.md",
            "status": "required",
        },
        {
            "task_id": "DEVICE-LAB",
            "requirement": "Physical Android/OEM and iOS TestFlight evidence is attached.",
            "artifact": "device-lab/*.md",
            "status": "blocked" if release_blockers else "covered",
            "blockers": release_blockers,
        },
    ]


def _render_gate_markdown(report: ReleasePackagingReport) -> str:
    lines = [
        "# PER-227 Release Packaging And Operator Gate",
        "",
        f"Generated: {report.generated_at}",
        "",
        "| Platform | Support | Owner | Modes | Commands | Release blockers |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for row in report.platform_rows:
        commands = "<br>".join(command["command_id"] for command in row["commands"])
        blockers = "<br>".join(row["release_blockers"]) if row["release_blockers"] else "None"
        lines.append(
            "| {label} | {support} | {owner} | {modes} | {commands} | {blockers} |".format(
                label=row["label"],
                support=row["support_code"],
                owner=row["owner"],
                modes=", ".join(row["modes"]),
                commands=commands,
                blockers=blockers,
            )
        )
    lines.extend(["", "## Commands", ""])
    for row in report.platform_rows:
        for command in row["commands"]:
            skip = f" Skip: {command['skip_reason']}" if command["skip_reason"] else ""
            lines.append(
                f"- `{command['command_id']}` `{command['platform']}` owner `{command['owner']}`: "
                f"`{command['command']}` -> artifact `{command['artifact']}`, log "
                f"`{command['log_artifact']}`.{skip}"
            )
    lines.extend(["", "## Negative Gates", ""])
    for gate in report.negative_gates:
        lines.append(
            f"- `{gate['gate_id']}` `{gate['category']}`: {gate['assertion']} "
            f"Artifact: `{gate['proving_artifact']}`."
        )
    lines.extend(["", "## Readiness Checklist", ""])
    for item in report.final_readiness_checklist:
        lines.append(
            f"- `{item['task_id']}` `{item['status']}`: {item['requirement']} "
            f"Artifact: `{item['artifact']}`."
        )
    return "\n".join(lines) + "\n"


def _render_runbook_markdown(report: ReleasePackagingReport) -> str:
    lines = [
        "# PER-227 Operator Release Runbook",
        "",
        (
            "This runbook records the install, update, backup, diagnostics, and rollback "
            "steps required by QA-006. It is a gate artifact, not final production approval "
            "while platform blockers remain."
        ),
        "",
    ]
    for section in report.runbook_sections:
        lines.extend([f"## {section['title']}", "", f"Owner: `{section['owner']}`", ""])
        for step in section["steps"]:
            lines.append(f"- {step}")
        lines.extend(["", f"Required artifact: `{section['required_artifact']}`", ""])
    lines.extend(
        [
            "## Release Guardrails",
            "",
            "- Mock transport artifacts are fixture evidence only and must not be attached as production proof.",
            "- Android emulator-only and iOS simulator-only evidence remain partial until physical/TestFlight matrices are attached.",
            "- Redacted diagnostics must omit raw credentials, Redis URLs, host paths, raw audio, and raw RAG records.",
            "- Rollback must use a prior release whose QA-001 through QA-006 artifacts are complete for the affected platform.",
        ]
    )
    return "\n".join(lines) + "\n"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=REPORT_ROOT / "latest",
        help="Directory for release_packaging_gate.json, release_packaging_gate.md, and runbook.md.",
    )
    parser.add_argument(
        "--print-summary",
        action="store_true",
        help="Print the generated summary JSON.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = build_report(args.output_dir)
    if args.print_summary:
        print(json.dumps(report.summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
