"""Generate PER-223 multi-mode E2E release matrix artifacts.

The matrix is intentionally evidence-oriented. It records the commands,
workflow jobs, owners, artifacts, supported modes, and explicit release
deferrals needed for QA-002 without claiming that fixture-only or emulator-only
checks prove production readiness.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

REPORT_ROOT = Path(".omx/reports/multi-mode-e2e")


@dataclass(frozen=True)
class MatrixEvidence:
    """One executable or manual evidence item for a matrix row."""

    evidence_id: str
    command: str
    workflow: str
    artifact: str
    owner: str
    required_for_release: bool = True
    manual: bool = False
    skip_reason: str | None = None


@dataclass(frozen=True)
class MatrixRow:
    """One deployment/platform row in the PER-223 matrix."""

    mode_id: str
    label: str
    platform: str
    support_code: str
    gate_status: str
    owner: str
    sdk_transport: str
    backend_boundary: str
    runtime_modes: tuple[str, ...]
    privacy_classes: tuple[str, ...]
    evidence: tuple[MatrixEvidence, ...]
    release_blockers: tuple[str, ...] = ()
    notes: tuple[str, ...] = ()


@dataclass(frozen=True)
class NegativeCase:
    """Security/privacy negative case required by QA-002."""

    case_id: str
    category: str
    assertion: str
    proving_artifact: str


@dataclass(frozen=True)
class RunbookSection:
    """Release runbook coverage entry."""

    section_id: str
    title: str
    required_commands: tuple[str, ...]
    artifact: str
    owner: str


@dataclass
class MatrixReport:
    """Serializable top-level matrix report."""

    report_id: str
    generated_at: str
    issue: str
    branch: str
    source_docs: list[str]
    rows: list[dict[str, Any]]
    negative_cases: list[dict[str, Any]]
    mesh_addendum_scenarios: list[str]
    runbook_sections: list[dict[str, Any]]
    final_readiness_checklist: list[dict[str, Any]]
    summary: dict[str, Any]
    artifacts: dict[str, str]
    secrets_redacted: bool = True


MATRIX_ROWS: tuple[MatrixRow, ...] = (
    MatrixRow(
        mode_id="server_web",
        label="Server Web",
        platform="browser on hosted/operator Gateway",
        support_code="supported",
        gate_status="ci_required",
        owner="qa-release",
        sdk_transport="HTTP Gateway transport via AuroraClient",
        backend_boundary=(
            "Gateway/Auth/Config/Supervisor/Mesh/Orchestrator/Tooling through public SDK paths"
        ),
        runtime_modes=("http_gateway_thin_client", "thread_localbus", "process_bullmq_redis"),
        privacy_classes=("personal", "sensitive", "credential", "admin-critical"),
        evidence=(
            MatrixEvidence(
                "server-web-sdk",
                "pnpm --filter @aurora/client test && pnpm --filter @aurora/client typecheck",
                ".github/workflows/test-e2e.yml#frontend_sdk_ui_web",
                "aurora-multi-mode-e2e-matrix/matrix.json",
                "qa-release",
            ),
            MatrixEvidence(
                "server-web-app",
                "pnpm --filter @aurora/web test && pnpm --filter @aurora/web typecheck",
                ".github/workflows/test-e2e.yml#frontend_sdk_ui_web",
                "aurora-multi-mode-e2e-matrix/runbook.md",
                "qa-release",
            ),
        ),
        notes=("Uses HTTP and SDK conformance fixtures as the harness boundary.",),
    ),
    MatrixRow(
        mode_id="desktop_thin",
        label="Desktop Thin",
        platform="desktop shell/browser connected to remote Gateway",
        support_code="supported",
        gate_status="ci_required",
        owner="qa-release",
        sdk_transport="HTTP Gateway transport with desktop storage/window affordances only",
        backend_boundary="Remote Gateway via AuroraClient; no direct Python service access",
        runtime_modes=("http_gateway_thin_client",),
        privacy_classes=("personal", "credential"),
        evidence=(
            MatrixEvidence(
                "desktop-thin-ui",
                "pnpm --filter @aurora/ui test && pnpm --filter @aurora/ui typecheck",
                ".github/workflows/test-e2e.yml#frontend_sdk_ui_web",
                "aurora-multi-mode-e2e-matrix/matrix.md",
                "qa-release",
            ),
        ),
        notes=(
            "Thin mode must not claim native device APIs unless the native manifest exposes them.",
        ),
    ),
    MatrixRow(
        mode_id="desktop_local",
        label="Desktop Local",
        platform="Tauri desktop local node/sidecar",
        support_code="partial",
        gate_status="ci_required",
        owner="tauri-native",
        sdk_transport="Tauri local transport via AuroraClient",
        backend_boundary="Tauri command bridge to local Gateway/bus contracts",
        runtime_modes=("tauri_local_native", "thread_localbus"),
        privacy_classes=("personal", "credential", "admin-critical"),
        evidence=(
            MatrixEvidence(
                "desktop-local-tauri",
                "pnpm --filter @aurora/tauri-ui test && pnpm --filter @aurora/tauri-ui build",
                ".github/workflows/tauri-desktop.yml#linux-tauri",
                "tauri desktop build and smoke logs",
                "tauri-native",
            ),
        ),
        release_blockers=(
            "Signed installer/updater artifacts remain owned by QA-006 "
            "before final production release.",
        ),
    ),
    MatrixRow(
        mode_id="mesh_shell",
        label="Mesh Shell",
        platform="local/thin UI attached to mesh-capable node",
        support_code="supported",
        gate_status="ci_required",
        owner="mesh-backend",
        sdk_transport="Mesh P2P transport and route/privacy policy helpers",
        backend_boundary=(
            "Gateway mesh status, route explain, Tooling, RAG, Audio, Scheduler, "
            "audit/support bundle contracts"
        ),
        runtime_modes=("mesh_webrtc", "thread_localbus", "process_bullmq_redis"),
        privacy_classes=("personal", "sensitive", "raw-audio", "credential", "admin-critical"),
        evidence=(
            MatrixEvidence(
                "mesh-gap-harness",
                "uv run pytest tests/e2e/test_mesh_gap_e2e_harness.py -q",
                ".github/workflows/test-e2e.yml#python_mesh_and_matrix",
                ".omx/reports/mesh-gap-e2e/latest/report.json",
                "mesh-backend",
            ),
        ),
        notes=("Final mesh proof is the production two-peer MESH-GAP-011 harness.",),
    ),
    MatrixRow(
        mode_id="android_thin",
        label="Android Thin",
        platform="Android app connected to remote/server Gateway",
        support_code="partial",
        gate_status="ci_required_with_manual_device_lab",
        owner="android-native",
        sdk_transport="HTTP Gateway transport plus Android native capability manifest",
        backend_boundary=(
            "Remote Gateway via AuroraClient; native permissions only when manifest-gated"
        ),
        runtime_modes=("http_gateway_thin_client",),
        privacy_classes=("personal", "credential", "raw-audio"),
        evidence=(
            MatrixEvidence(
                "android-emulator",
                "pnpm --filter @aurora/tauri-ui android:build:apk:x86_64:debug && "
                "pnpm --filter @aurora/tauri-ui android:smoke",
                ".github/workflows/tauri-android.yml#android-tauri",
                "aurora-tauri-android-apk and emulator smoke logs",
                "android-native",
            ),
            MatrixEvidence(
                "android-physical-assistant-role",
                "pnpm --filter @aurora/tauri-ui android:release-gate:strict",
                "manual-device-lab/android",
                "device-lab/android-assistant-role-and-oem-matrix.md",
                "android-native",
                manual=True,
                skip_reason=(
                    "Physical/OEM assistant-role matrix cannot be proven by emulator-only CI."
                ),
            ),
        ),
        release_blockers=(
            "Physical/OEM assistant-role matrix evidence is required before production complete.",
        ),
    ),
    MatrixRow(
        mode_id="ios_thin",
        label="iOS Thin",
        platform="iOS app connected to remote/server Gateway",
        support_code="partial",
        gate_status="ci_required_with_manual_device_lab",
        owner="ios-native",
        sdk_transport="HTTP Gateway transport plus iOS App Intents/native capability manifest",
        backend_boundary=(
            "Remote Gateway via AuroraClient; Apple-permitted app/extension surfaces only"
        ),
        runtime_modes=("http_gateway_thin_client",),
        privacy_classes=("personal", "credential", "raw-audio"),
        evidence=(
            MatrixEvidence(
                "ios-simulator",
                "pnpm --filter @aurora/tauri-ui tauri ios build --target aarch64-sim "
                "--config src-tauri/tauri.ios.conf.json",
                ".github/workflows/tauri-ios.yml#macos-tauri-ios",
                "aurora-ios-app-intent-smoke and aurora-ios-entrypoint-payload-smoke",
                "ios-native",
            ),
            MatrixEvidence(
                "ios-physical-testflight",
                "manual TestFlight/App Store device smoke with App Intents, share extension, "
                "widgets, and file associations",
                "manual-device-lab/ios",
                "device-lab/ios-testflight-real-device-matrix.md",
                "ios-native",
                manual=True,
                skip_reason=(
                    "Real-device/TestFlight coverage cannot be proven by simulator-only CI."
                ),
            ),
        ),
        release_blockers=(
            "Real-device/TestFlight matrix evidence is required before production complete.",
        ),
    ),
)


MESH_ADDENDUM_SCENARIOS: tuple[str, ...] = (
    "local-only tool",
    "remote-only tool",
    "duplicated local+remote tool with explicit provider selector",
    "dangerous local tool approval",
    "dangerous remote tool approval",
    "approve-all session",
    "expired approval",
    "denied replay",
    "remote RAG namespace search/export/import preview",
    "remote STT session consent/event streaming",
    "scheduler remote delegation",
    "route explain",
    "diagnostics/audit support bundle",
)


NEGATIVE_CASES: tuple[NegativeCase, ...] = (
    NegativeCase(
        "dangerous-remote-missing-token",
        "tool_approval",
        "Remote dangerous tool denies execution without an approval token.",
        ".omx/reports/mesh-gap-e2e/latest/report.json",
    ),
    NegativeCase(
        "dangerous-remote-denied-replay",
        "tool_approval",
        "Remote approval token cannot be replayed or reused with mismatched args.",
        ".omx/reports/mesh-gap-e2e/latest/report.json",
    ),
    NegativeCase(
        "rag-missing-namespace",
        "data",
        (
            "Remote RAG denies missing namespace selector and preserves provenance for "
            "allowed namespace."
        ),
        ".omx/reports/mesh-gap-e2e/latest/report.json",
    ),
    NegativeCase(
        "audio-missing-consent",
        "raw-audio",
        (
            "Remote streaming audio denies missing consent token and emits session evidence "
            "only after approval."
        ),
        ".omx/reports/mesh-gap-e2e/latest/report.json",
    ),
    NegativeCase(
        "auth-config-mesh-denied",
        "admin-critical",
        "Broad Auth/Config mesh mutation RPC is denied outside pairing/login infrastructure.",
        ".omx/reports/mesh-gap-e2e/latest/report.json",
    ),
    NegativeCase(
        "support-bundle-redaction",
        "credential",
        (
            "Support bundle artifacts exclude raw tokens, Redis URLs, host paths, raw audio, "
            "and raw RAG records."
        ),
        ".omx/reports/mesh-gap-e2e/latest/support_bundle.json",
    ),
    NegativeCase(
        "mock-transport-not-production-proof",
        "release",
        "Mock transport is fixture-only and cannot be selected as production release evidence.",
        ".omx/reports/multi-mode-e2e/latest/matrix.json",
    ),
)


RUNBOOK_SECTIONS: tuple[RunbookSection, ...] = (
    RunbookSection(
        "install",
        "Install",
        (
            "uv sync --extra test-e2e --extra gateway --extra mode-processes",
            "pnpm install --frozen-lockfile",
        ),
        "install logs attached to release candidate",
        "release-ops",
    ),
    RunbookSection(
        "update",
        "Update",
        (
            "pnpm --filter @aurora/tauri-ui build:bundle",
            "python scripts/build.py --target wheel --clean",
        ),
        "signed app/update artifacts from QA-006",
        "release-ops",
    ),
    RunbookSection(
        "backup",
        "Backup",
        (
            "AuroraClient backup APIs / AdminAction-gated backend backup workflow",
            "verify config, DB/RAG, and model artifact inventory before update",
        ),
        "backup manifest and restore rehearsal log",
        "release-ops",
    ),
    RunbookSection(
        "diagnostics",
        "Diagnostics",
        (
            "uv run python scripts/mesh_gap_e2e_harness.py",
            "collect redacted Gateway support bundle and correlation IDs",
        ),
        ".omx/reports/mesh-gap-e2e/latest/support_bundle.json",
        "qa-release",
    ),
    RunbookSection(
        "rollback",
        "Rollback",
        (
            "restore previous signed package/sidecar bundle",
            "restore backed-up config and data only after AdminAction confirmation",
        ),
        "rollback checklist and restore audit receipt",
        "release-ops",
    ),
)


def build_report(output_dir: Path) -> MatrixReport:
    """Build and persist the matrix report."""

    output_dir.mkdir(parents=True, exist_ok=True)
    artifacts = {
        "json": str(output_dir / "matrix.json"),
        "markdown": str(output_dir / "matrix.md"),
        "runbook": str(output_dir / "runbook.md"),
    }
    rows = [asdict(row) for row in MATRIX_ROWS]
    manual_items = [
        evidence
        for row in MATRIX_ROWS
        for evidence in row.evidence
        if evidence.manual
    ]
    release_blockers = [
        blocker
        for row in MATRIX_ROWS
        for blocker in row.release_blockers
    ]
    checklist = _readiness_checklist(release_blockers)
    report = MatrixReport(
        report_id="PER-223-QA-002-multi-mode-e2e",
        generated_at=datetime.now(UTC).isoformat(),
        issue="PER-223",
        branch="multica/PER-223-multi-mode-e2e-matrix",
        source_docs=[
            ".omx/specs/ui-production-tasks/tasks/QA-002-build-multi-mode-e2e-matrix.md",
            ".omx/specs/ui-production-tasks/backend-gap-crosswalk.md",
            ".omx/specs/ui-refinement/aurora-ui-sdk-contract.md",
            ".omx/specs/mesh-ui-roadmap-integration-review.md",
            "docs/MESH_GAP_E2E_HARNESS.md",
        ],
        rows=rows,
        negative_cases=[asdict(case) for case in NEGATIVE_CASES],
        mesh_addendum_scenarios=list(MESH_ADDENDUM_SCENARIOS),
        runbook_sections=[asdict(section) for section in RUNBOOK_SECTIONS],
        final_readiness_checklist=checklist,
        summary={
            "row_count": len(MATRIX_ROWS),
            "required_modes": [row.mode_id for row in MATRIX_ROWS],
            "automated_evidence_items": sum(
                1 for row in MATRIX_ROWS for evidence in row.evidence if not evidence.manual
            ),
            "manual_device_lab_items": [item.evidence_id for item in manual_items],
            "release_blockers": release_blockers,
            "production_complete": not release_blockers,
            "mock_transport_release_evidence_allowed": False,
            "security_negative_case_count": len(NEGATIVE_CASES),
            "mesh_addendum_scenario_count": len(MESH_ADDENDUM_SCENARIOS),
            "runbook_sections": [section.section_id for section in RUNBOOK_SECTIONS],
        },
        artifacts=artifacts,
    )
    (output_dir / "matrix.json").write_text(
        json.dumps(asdict(report), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (output_dir / "matrix.md").write_text(_render_matrix_markdown(report), encoding="utf-8")
    (output_dir / "runbook.md").write_text(_render_runbook_markdown(report), encoding="utf-8")
    return report


def _readiness_checklist(release_blockers: list[str]) -> list[dict[str, Any]]:
    return [
        {
            "task_id": "QA-001",
            "requirement": "SDK/backend contract conformance CI is green.",
            "artifact": "packages/aurora-sdk/tests/conformance.test.ts",
            "status": "required",
        },
        {
            "task_id": "QA-002",
            "requirement": "Multi-mode E2E matrix has JSON, Markdown, and runbook artifacts.",
            "artifact": ".omx/reports/multi-mode-e2e/latest/matrix.json",
            "status": "covered",
        },
        {
            "task_id": "QA-003",
            "requirement": "Security/privacy negative cases are represented in E2E evidence.",
            "artifact": ".omx/reports/mesh-gap-e2e/latest/report.json",
            "status": "covered",
        },
        {
            "task_id": "QA-004",
            "requirement": (
                "Accessibility, responsive, and visual regression suite must attach artifacts."
            ),
            "artifact": "future QA-004 artifact bundle",
            "status": "required",
        },
        {
            "task_id": "QA-006",
            "requirement": "Release packaging and operator runbooks must attach signed artifacts.",
            "artifact": "docs/MULTI_MODE_E2E_RELEASE_RUNBOOK.md",
            "status": "required",
        },
        {
            "task_id": "DEVICE-LAB",
            "requirement": (
                "Physical/OEM Android and real-device/TestFlight iOS evidence is attached."
            ),
            "artifact": "device-lab/*.md",
            "status": "blocked" if release_blockers else "covered",
            "blockers": release_blockers,
        },
    ]


def _render_matrix_markdown(report: MatrixReport) -> str:
    lines = [
        "# PER-223 Multi-Mode E2E Matrix",
        "",
        f"Generated: {report.generated_at}",
        "",
        "| Mode | Support | Gate | Owner | Runtime modes | Release blockers |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for row in report.rows:
        blockers = "<br>".join(row["release_blockers"]) if row["release_blockers"] else "None"
        lines.append(
            (
                "| {label} | {support_code} | {gate_status} | {owner} | "
                "{runtime_modes} | {blockers} |"
            ).format(
                label=row["label"],
                support_code=row["support_code"],
                gate_status=row["gate_status"],
                owner=row["owner"],
                runtime_modes=", ".join(row["runtime_modes"]),
                blockers=blockers,
            )
        )
    lines.extend(
        [
            "",
            "## Security And Privacy Negative Cases",
            "",
        ]
    )
    for case in report.negative_cases:
        lines.append(
            f"- `{case['case_id']}`: {case['assertion']} "
            f"Artifact: `{case['proving_artifact']}`."
        )
    lines.extend(
        [
            "",
            "## Mesh Addendum Scenarios",
            "",
        ]
    )
    for scenario in report.mesh_addendum_scenarios:
        lines.append(f"- {scenario}")
    lines.extend(
        [
            "",
            "## Summary",
            "",
            f"- Production complete: `{str(report.summary['production_complete']).lower()}`",
            "- Mock transport release evidence allowed: "
            f"`{str(report.summary['mock_transport_release_evidence_allowed']).lower()}`",
            f"- Manual device-lab items: {', '.join(report.summary['manual_device_lab_items'])}",
        ]
    )
    return "\n".join(lines) + "\n"


def _render_runbook_markdown(report: MatrixReport) -> str:
    lines = [
        "# PER-223 Release Gate Runbook",
        "",
        (
            "This runbook records the QA-002 release gate commands and artifacts. It is not "
            "a final production approval while manual device-lab blockers remain."
        ),
        "",
    ]
    for section in report.runbook_sections:
        lines.extend(
            [
                f"## {section['title']}",
                "",
                f"Owner: `{section['owner']}`",
                "",
                "Commands/evidence:",
            ]
        )
        for command in section["required_commands"]:
            lines.append(f"- `{command}`")
        lines.extend(["", f"Artifact: `{section['artifact']}`", ""])
    lines.extend(
        [
            "## Rollup Checklist",
            "",
        ]
    )
    for item in report.final_readiness_checklist:
        lines.append(
            f"- `{item['task_id']}` `{item['status']}`: {item['requirement']} "
            f"Artifact: `{item['artifact']}`."
        )
    return "\n".join(lines) + "\n"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=REPORT_ROOT / "latest",
        help="Directory for matrix.json, matrix.md, and runbook.md.",
    )
    parser.add_argument(
        "--print-summary",
        action="store_true",
        help="Print the summary JSON to stdout.",
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
