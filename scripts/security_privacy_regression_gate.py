"""Generate PER-224 security/privacy regression gate artifacts.

The gate is evidence-oriented: it records the adversarial cases, commands,
platforms, owners, release skips, and runbook sections required before Aurora
can claim production security/privacy readiness.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

REPORT_ROOT = Path(".omx/reports/security-privacy-regression")


@dataclass(frozen=True)
class RegressionCase:
    """One adversarial security/privacy regression case."""

    case_id: str
    category: str
    assertion: str
    command: str
    artifact: str
    owner: str
    platforms: tuple[str, ...]
    source_task_ids: tuple[str, ...]
    expected_error: str | None = None
    negative: bool = True


@dataclass(frozen=True)
class GateCommand:
    """One command that contributes release gate evidence."""

    command_id: str
    command: str
    owner: str
    platforms: tuple[str, ...]
    artifact: str
    required_for_release: bool = True
    skip_reason: str | None = None


@dataclass(frozen=True)
class RunbookSection:
    """Release runbook section required by PER-224."""

    section_id: str
    title: str
    owner: str
    commands: tuple[str, ...]
    artifact: str


@dataclass
class SecurityPrivacyGateReport:
    """Serializable top-level PER-224 gate report."""

    report_id: str
    generated_at: str
    issue: str
    branch: str
    source_docs: list[str]
    cases: list[dict[str, Any]]
    commands: list[dict[str, Any]]
    runbook_sections: list[dict[str, Any]]
    final_readiness_checklist: list[dict[str, Any]]
    summary: dict[str, Any]
    artifacts: dict[str, str]
    secrets_redacted: bool = True


SECURITY_PRIVACY_CASES: tuple[RegressionCase, ...] = (
    RegressionCase(
        "mesh-missing-explicit-selector",
        "route_privacy",
        "Remote Tooling execution requiring explicit target fails closed without a selector.",
        "uv run --extra test --extra gateway pytest tests/unit/gateway/test_routing_table.py::test_policy_can_require_explicit_selector -q",
        "pytest junit/security-privacy-route-policy.xml",
        "mesh-backend",
        ("thread_localbus", "mesh_webrtc"),
        ("SDK-012", "MESH-GAP-002", "QA-003"),
        "selector_required",
    ),
    RegressionCase(
        "mesh-stale-peer-blocked",
        "route_privacy",
        "Stale providers are excluded from route selection and cannot be selected for execution.",
        "uv run --extra test --extra gateway pytest tests/integration/test_mesh_routing.py::TestMeshRoutingIntegration::test_stale_peer_excluded_from_routing -q",
        "pytest junit/security-privacy-mesh-routing.xml",
        "mesh-backend",
        ("thread_localbus", "mesh_webrtc"),
        ("MESH-GAP-003", "QA-003"),
        "selector_peer_stale",
    ),
    RegressionCase(
        "mesh-denied-peer-blocked",
        "auth_rbac",
        "Denied mesh peers cannot invoke service methods even when a route exists.",
        "uv run --extra test --extra gateway pytest tests/integration/test_mesh_permissions.py -q",
        "pytest junit/security-privacy-mesh-permissions.xml",
        "mesh-backend",
        ("thread_localbus", "mesh_webrtc"),
        ("MESH-GAP-005", "QA-003"),
        "permission_denied",
    ),
    RegressionCase(
        "rpc-privilege-mismatch-denied",
        "auth_rbac",
        "RPC handler denies callers whose peer/principal lacks the required method permission.",
        "uv run --extra test --extra gateway pytest tests/unit/gateway/test_rpc.py::test_handle_call_forbidden -q",
        "pytest junit/security-privacy-rpc.xml",
        "mesh-backend",
        ("thread_localbus", "mesh_webrtc"),
        ("MESH-GAP-005", "QA-003"),
        "forbidden",
    ),
    RegressionCase(
        "local-raw-confirmed-bypass-denied",
        "tool_approval",
        "Local/internal approval-required tools cannot be executed with raw confirmed=true.",
        "uv run --extra test --extra service-tooling pytest tests/unit/tooling/test_service.py::TestToolingSharingPolicyAndApproval::test_raw_confirmed_does_not_bypass_approval_token -q",
        "pytest junit/security-privacy-tooling.xml",
        "qa-release",
        ("thread_localbus",),
        ("BE-004", "MESH-GAP-005", "QA-003"),
        "approval_token_required",
    ),
    RegressionCase(
        "remote-raw-confirmed-bypass-denied",
        "tool_approval",
        "Remote mesh approval-required tools cannot be executed with raw confirmed=true.",
        "uv run --extra test --extra service-tooling pytest tests/unit/tooling/test_service.py::TestToolingSharingPolicyAndApproval::test_raw_confirmed_does_not_bypass_approval_token -q",
        "pytest junit/security-privacy-tooling.xml",
        "qa-release",
        ("mesh_webrtc",),
        ("BE-004", "MESH-GAP-005", "QA-003"),
        "approval_token_required",
    ),
    RegressionCase(
        "approval-token-replay-denied",
        "tool_approval",
        "Approval tokens are single use and replay attempts fail closed.",
        "uv run --extra test --extra service-tooling pytest tests/unit/tooling/test_service.py::TestToolingSharingPolicyAndApproval::test_token_replay_is_denied -q",
        "pytest junit/security-privacy-tooling.xml",
        "qa-release",
        ("thread_localbus", "mesh_webrtc"),
        ("BE-004", "MESH-GAP-005", "QA-003"),
        "approval_token_replayed",
    ),
    RegressionCase(
        "approval-token-args-hash-mismatch-denied",
        "tool_approval",
        "Approval tokens are bound to the approved argument hash.",
        "uv run --extra test --extra service-tooling pytest tests/unit/tooling/test_service.py::TestToolingSharingPolicyAndApproval::test_token_binding_mismatches_are_denied -q",
        "pytest junit/security-privacy-tooling.xml",
        "qa-release",
        ("thread_localbus", "mesh_webrtc"),
        ("BE-004", "MESH-GAP-005", "QA-003"),
        "approval_token_args_hash_mismatch",
    ),
    RegressionCase(
        "approval-token-provider-mismatch-denied",
        "tool_approval",
        "Approval tokens are bound to caller/provider identity and reject changed providers.",
        "uv run --extra test --extra service-tooling pytest tests/unit/tooling/test_service.py::TestToolingSharingPolicyAndApproval::test_token_binding_mismatches_are_denied -q",
        "pytest junit/security-privacy-tooling.xml",
        "qa-release",
        ("thread_localbus", "mesh_webrtc"),
        ("BE-004", "MESH-GAP-005", "QA-003"),
        "approval_token_caller_peer_id_mismatch",
    ),
    RegressionCase(
        "approval-token-expired-denied",
        "tool_approval",
        "Expired approval tokens are denied before tool invocation.",
        "uv run --extra test --extra service-tooling pytest tests/unit/tooling/test_service.py::TestToolingSharingPolicyAndApproval::test_token_resource_mismatch_and_expiry_are_denied -q",
        "pytest junit/security-privacy-tooling.xml",
        "qa-release",
        ("thread_localbus", "mesh_webrtc"),
        ("BE-004", "MESH-GAP-005", "QA-003"),
        "approval_token_expired",
    ),
    RegressionCase(
        "approve-all-peer-scope-escape-denied",
        "tool_approval",
        "Approve-all-for-peer cannot run without a caller peer scope.",
        "uv run --extra test --extra service-tooling pytest tests/unit/tooling/test_service.py::TestToolingSharingPolicyAndApproval::test_approve_all_and_deny_modes -q",
        "pytest junit/security-privacy-tooling.xml",
        "qa-release",
        ("thread_localbus", "mesh_webrtc"),
        ("BE-004", "MESH-GAP-005", "QA-003"),
        "policy_denied",
    ),
    RegressionCase(
        "dry-run-bypass-denied",
        "tool_approval",
        "Dry-run-only policy denies real execution and only permits dry-run status.",
        "uv run --extra test --extra service-tooling pytest tests/unit/tooling/test_service.py::TestToolingSharingPolicyAndApproval::test_approve_all_and_deny_modes -q",
        "pytest junit/security-privacy-tooling.xml",
        "qa-release",
        ("thread_localbus", "mesh_webrtc"),
        ("BE-004", "MESH-GAP-005", "QA-003"),
        "dry_run_only",
    ),
    RegressionCase(
        "remote-rag-namespace-denied",
        "data",
        "Remote RAG rejects missing or mismatched namespace selectors and redacts records.",
        "uv run --extra test --extra service-db --extra gateway pytest tests/integration/test_mesh_rag_namespace_policy.py tests/unit/db/test_service.py::TestDBServiceRAGProvenance -q",
        "pytest junit/security-privacy-rag.xml",
        "db-backend",
        ("thread_localbus", "mesh_webrtc"),
        ("BE-017", "MESH-GAP-007", "QA-003"),
        "namespace_selector_required",
    ),
    RegressionCase(
        "remote-audio-consent-denied",
        "raw-audio",
        "Remote playback or live audio sessions deny missing consent/target selector.",
        "uv run --extra test-e2e --extra gateway pytest tests/e2e/test_mesh_gap_e2e_harness.py::test_mesh_gap_harness_records_security_privacy_negative_cases -q",
        "pytest junit/security-privacy-audio.xml",
        "mesh-backend",
        ("mesh_webrtc",),
        ("MESH-GAP-008", "QA-003"),
        "consent_token_required",
    ),
    RegressionCase(
        "scheduler-foreign-namespace-denied",
        "scheduler",
        "Scheduler list/cancel operations are scoped to namespace and owner peer/principal.",
        "uv run --extra test --extra service-scheduler pytest tests/unit/app/scheduler/test_scheduler_remote_policy.py -q",
        "pytest junit/security-privacy-scheduler.xml",
        "scheduler-backend",
        ("thread_localbus", "mesh_webrtc"),
        ("BE-018", "MESH-GAP-009", "QA-003"),
        "owner_scope_mismatch",
    ),
    RegressionCase(
        "support-bundle-redaction-leak-denied",
        "credential",
        "Diagnostics/support bundles omit raw tokens, Redis URLs, host paths, raw audio, and raw RAG records.",
        "uv run --extra test-e2e --extra gateway pytest tests/e2e/test_mesh_gap_e2e_harness.py::test_mesh_gap_artifacts_are_redacted_and_correlation_ready -q",
        "pytest junit/security-privacy-redaction.xml",
        "qa-release",
        ("thread_localbus", "process_bullmq_redis", "mesh_webrtc"),
        ("ADM-008", "ADM-009", "MESH-GAP-010", "QA-003"),
        "redaction_required",
    ),
)


GATE_COMMANDS: tuple[GateCommand, ...] = (
    GateCommand(
        "unit-security-privacy",
        "uv run --extra test --extra service-scheduler --extra service-tooling --extra gateway pytest tests/unit/tooling/test_service.py::TestToolingSharingPolicyAndApproval tests/unit/app/scheduler/test_scheduler_remote_policy.py tests/unit/gateway/test_rpc.py -q",
        "qa-release",
        ("thread_localbus",),
        ".omx/reports/security-privacy-regression/latest/unit-security-privacy.log",
    ),
    GateCommand(
        "integration-security-privacy",
        "uv run --extra test --extra service-db --extra service-scheduler --extra service-tooling --extra gateway pytest tests/integration/test_mesh_routing.py tests/integration/test_mesh_permissions.py tests/integration/test_mesh_rag_namespace_policy.py -q",
        "qa-release",
        ("thread_localbus", "mesh_webrtc"),
        ".omx/reports/security-privacy-regression/latest/integration-security-privacy.log",
    ),
    GateCommand(
        "mesh-e2e-security-privacy",
        "uv run --extra test-e2e --extra gateway pytest tests/e2e/test_mesh_gap_e2e_harness.py -q",
        "qa-release",
        ("mesh_webrtc", "http_gateway_thin_client", "tauri_local_native"),
        ".omx/reports/mesh-gap-e2e/latest/report.json",
    ),
    GateCommand(
        "process-mode-security-privacy",
        "uv run --extra test-e2e --extra gateway --extra mode-processes pytest tests/e2e/test_mesh_gap_e2e_harness.py --redis-url ${REDIS_URL} -q",
        "qa-release",
        ("process_bullmq_redis",),
        ".omx/reports/mesh-gap-e2e/latest/report.json",
        skip_reason="Allowed only when Redis/process-mode dependencies are unavailable; must be recorded as dependency_gap, never pass.",
    ),
    GateCommand(
        "full-ci-security-privacy",
        "make check && make test",
        "qa-release",
        ("thread_localbus", "process_bullmq_redis"),
        "CI workflow logs for PER-224 security/privacy gate",
    ),
)


RUNBOOK_SECTIONS: tuple[RunbookSection, ...] = (
    RunbookSection(
        "install",
        "Install",
        "release-ops",
        (
            "uv sync --extra test-e2e --extra gateway --extra mode-processes",
            "pnpm install --frozen-lockfile",
        ),
        "dependency installation logs attached to the release candidate",
    ),
    RunbookSection(
        "update",
        "Update",
        "release-ops",
        (
            "python scripts/build.py --target wheel --clean",
            "pnpm --filter @aurora/tauri-ui build:bundle",
        ),
        "signed package/update artifacts from QA-006",
    ),
    RunbookSection(
        "backup",
        "Backup",
        "release-ops",
        (
            "create AdminAction-gated config and DB/RAG backup",
            "verify model/runtime artifact inventory before upgrade",
        ),
        "backup manifest plus restore rehearsal log",
    ),
    RunbookSection(
        "diagnostics",
        "Diagnostics",
        "qa-release",
        (
            "uv run python scripts/security_privacy_regression_gate.py --print-summary",
            "uv run python scripts/mesh_gap_e2e_harness.py",
        ),
        ".omx/reports/security-privacy-regression/latest/security_privacy_gate.json",
    ),
    RunbookSection(
        "rollback",
        "Rollback",
        "release-ops",
        (
            "restore previous signed package/sidecar bundle",
            "restore config/data only after AdminAction confirmation",
            "rerun security/privacy smoke subset after rollback",
        ),
        "rollback checklist, restore audit receipt, and redacted diagnostics bundle",
    ),
)


def build_report(output_dir: Path) -> SecurityPrivacyGateReport:
    """Build and persist PER-224 security/privacy gate artifacts."""

    output_dir.mkdir(parents=True, exist_ok=True)
    artifacts = {
        "json": str(output_dir / "security_privacy_gate.json"),
        "markdown": str(output_dir / "security_privacy_gate.md"),
        "runbook": str(output_dir / "runbook.md"),
    }
    cases = [asdict(case) for case in SECURITY_PRIVACY_CASES]
    commands = [asdict(command) for command in GATE_COMMANDS]
    report = SecurityPrivacyGateReport(
        report_id="PER-224-QA-003-security-privacy-regression",
        generated_at=datetime.now(UTC).isoformat(),
        issue="PER-224",
        branch="multica/QA-003-security-privacy-regression-suite",
        source_docs=[
            ".omx/specs/ui-production-tasks/tasks/QA-003-build-security-privacy-regression-suite.md",
            ".omx/specs/ui-production-tasks/backend-gap-crosswalk.md",
            ".omx/specs/ui-refinement/aurora-ui-sdk-contract.md",
            ".omx/specs/mesh-ui-roadmap-integration-review.md",
            ".omx/specs/deep-interview-mesh-distributed-integration.md",
        ],
        cases=cases,
        commands=commands,
        runbook_sections=[asdict(section) for section in RUNBOOK_SECTIONS],
        final_readiness_checklist=_readiness_checklist(),
        summary={
            "case_count": len(SECURITY_PRIVACY_CASES),
            "negative_case_count": sum(1 for case in SECURITY_PRIVACY_CASES if case.negative),
            "categories": sorted({case.category for case in SECURITY_PRIVACY_CASES}),
            "platforms": sorted(
                {platform for case in SECURITY_PRIVACY_CASES for platform in case.platforms}
            ),
            "required_commands": [command.command_id for command in GATE_COMMANDS],
            "accepted_skips": {
                command.command_id: command.skip_reason
                for command in GATE_COMMANDS
                if command.skip_reason
            },
            "owners": sorted({case.owner for case in SECURITY_PRIVACY_CASES}),
            "runbook_sections": [section.section_id for section in RUNBOOK_SECTIONS],
            "mock_transport_release_evidence_allowed": False,
            "production_complete": False,
        },
        artifacts=artifacts,
    )
    (output_dir / "security_privacy_gate.json").write_text(
        json.dumps(asdict(report), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (output_dir / "security_privacy_gate.md").write_text(
        _render_gate_markdown(report),
        encoding="utf-8",
    )
    (output_dir / "runbook.md").write_text(_render_runbook_markdown(report), encoding="utf-8")
    return report


def _readiness_checklist() -> list[dict[str, Any]]:
    return [
        {
            "task_id": "BE-004",
            "requirement": "AdminAction draft/confirm/audit enforcement is covered.",
            "artifact": "tests/unit/tooling/test_service.py",
            "status": "covered",
        },
        {
            "task_id": "SDK-012",
            "requirement": "Route/privacy policy denies missing selector and stale/denied peers.",
            "artifact": "tests/integration/test_mesh_routing.py",
            "status": "covered",
        },
        {
            "task_id": "ADM-008",
            "requirement": "Audit export/redaction checks cover support-bundle leaks.",
            "artifact": "tests/e2e/test_mesh_gap_e2e_harness.py",
            "status": "covered",
        },
        {
            "task_id": "MESH-GAP-005",
            "requirement": "Local and remote tools share the same token-bound approval primitives.",
            "artifact": "tests/unit/tooling/test_service.py",
            "status": "covered",
        },
        {
            "task_id": "MESH-GAP-011",
            "requirement": "Two-peer mesh proof remains required for final production signoff.",
            "artifact": ".omx/reports/mesh-gap-e2e/latest/report.json",
            "status": "required",
        },
        {
            "task_id": "QA-003",
            "requirement": "Security/privacy gate artifacts record commands, logs, platforms, skips, and owners.",
            "artifact": ".omx/reports/security-privacy-regression/latest/security_privacy_gate.json",
            "status": "covered",
        },
    ]


def _render_gate_markdown(report: SecurityPrivacyGateReport) -> str:
    lines = [
        "# PER-224 Security/Privacy Regression Gate",
        "",
        f"Generated: {report.generated_at}",
        "",
        "| Case | Category | Platforms | Owner | Expected denial | Artifact |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for case in report.cases:
        lines.append(
            "| {case_id} | {category} | {platforms} | {owner} | {error} | {artifact} |".format(
                case_id=case["case_id"],
                category=case["category"],
                platforms=", ".join(case["platforms"]),
                owner=case["owner"],
                error=case["expected_error"] or "n/a",
                artifact=case["artifact"],
            )
        )
    lines.extend(["", "## Commands", ""])
    for command in report.commands:
        skip = f" Skip: {command['skip_reason']}" if command["skip_reason"] else ""
        lines.append(
            f"- `{command['command_id']}` ({', '.join(command['platforms'])}): "
            f"`{command['command']}` -> `{command['artifact']}`.{skip}"
        )
    lines.extend(["", "## Readiness Checklist", ""])
    for item in report.final_readiness_checklist:
        lines.append(
            f"- `{item['task_id']}` `{item['status']}`: {item['requirement']} "
            f"Artifact: `{item['artifact']}`."
        )
    return "\n".join(lines) + "\n"


def _render_runbook_markdown(report: SecurityPrivacyGateReport) -> str:
    lines = [
        "# PER-224 Security/Privacy Release Runbook",
        "",
        (
            "This runbook records install, update, backup, diagnostics, and rollback "
            "requirements for the security/privacy production gate."
        ),
        "",
    ]
    for section in report.runbook_sections:
        lines.extend([f"## {section['title']}", "", f"Owner: `{section['owner']}`", ""])
        for command in section["commands"]:
            lines.append(f"- `{command}`")
        lines.extend(["", f"Artifact: `{section['artifact']}`", ""])
    lines.extend(["## Release Guardrails", ""])
    lines.append("- Mock transport artifacts are fixture evidence only, never production proof.")
    lines.append("- Process-mode Redis gaps must be recorded as dependency gaps, not passes.")
    lines.append(
        "- Raw tokens, Redis URLs, host paths, raw audio, and raw RAG records are forbidden."
    )
    return "\n".join(lines) + "\n"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=REPORT_ROOT / "latest",
        help="Directory for security_privacy_gate.json, security_privacy_gate.md, and runbook.md.",
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
