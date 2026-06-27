"""QA-008 transport parity release gate.

The gate combines executable transport evidence from the two-peer mesh harness
with SDK/UI command evidence into one redacted matrix artifact.  Missing live
Redis, Android, or iOS evidence is explicit and blocks release readiness rather
than being hidden by mock transport tests.
"""

from __future__ import annotations

import argparse
import json
import platform
import subprocess
import sys
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.mesh_gap_e2e_harness import HarnessReport, run_harness

REPORT_ROOT = Path(".omx/reports/transport-parity")

SENSITIVE_KEY_FRAGMENTS = (
    "api_key",
    "authorization",
    "bearer",
    "file_path",
    "password",
    "private_key",
    "redis_url",
    "secret",
    "token",
)


@dataclass(frozen=True)
class GateCommand:
    command_id: str
    owner: str
    command: tuple[str, ...]
    required_for_release: bool = True
    rationale: str = ""


@dataclass
class CommandResult:
    command_id: str
    owner: str
    command: list[str]
    status: str
    artifact_path: str | None
    returncode: int | None = None
    rationale: str = ""


@dataclass
class MatrixRow:
    row_id: str
    label: str
    owner: str
    status: str
    commands: list[str]
    artifact_paths: list[str]
    coverage: list[str]
    blocks_release: bool
    rationale: str
    evidence: dict[str, Any] = field(default_factory=dict)


GATE_COMMANDS: tuple[GateCommand, ...] = (
    GateCommand(
        command_id="sdk_build",
        owner="sdk",
        command=("pnpm", "--filter", "@aurora/client", "build"),
        rationale="Builds the SDK dist entry consumed by UI and Tauri package tests.",
    ),
    GateCommand(
        command_id="sdk_conformance",
        owner="sdk",
        command=("pnpm", "--filter", "@aurora/client", "test"),
        rationale="Runs the shared AuroraClient behavior suite across mock, HTTP, Tauri command, and mesh mock transports.",
    ),
    GateCommand(
        command_id="ui_flow_smoke",
        owner="frontend",
        command=("pnpm", "--filter", "@aurora/ui", "test"),
        rationale="Covers SDK-bound onboarding, assistant, admin topology, route sheet, diagnostics, and denied-state render models.",
    ),
    GateCommand(
        command_id="tauri_local_smoke",
        owner="desktop",
        command=("pnpm", "--filter", "@aurora/tauri-ui", "test"),
        rationale="Covers the Tauri local wrapper, offline fallback, and sidecar state boundary without inventing backend truth.",
    ),
    GateCommand(
        command_id="android_release_gate",
        owner="mobile",
        command=("pnpm", "--filter", "@aurora/tauri-ui", "android:release-gate"),
        required_for_release=False,
        rationale="Produces Android thin/local-light matrix evidence when Android SDK/emulator inputs exist.",
    ),
)


def run_transport_parity_gate(
    *,
    output_dir: Path = REPORT_ROOT,
    execute_commands: bool = False,
    command_runner: Callable[[GateCommand, Path], CommandResult] | None = None,
    harness_runner: Callable[[Path], HarnessReport] = run_harness,
) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    harness_dir = output_dir / "mesh-gap-e2e"
    harness_report = harness_runner(output_dir=harness_dir)
    command_results = [
        _run_gate_command(command, output_dir, command_runner)
        if execute_commands or command_runner
        else _not_run_result(command)
        for command in GATE_COMMANDS
    ]
    rows = _build_rows(harness_report, command_results)
    summary = _build_summary(rows, command_results, harness_report)
    report = {
        "gate_id": "QA-008",
        "issue": "PER-229",
        "generated_at": _now(),
        "release_ready": summary["status"] == "pass",
        "summary": summary,
        "rows": [asdict(row) for row in rows],
        "command_results": [asdict(result) for result in command_results],
        "artifacts": {
            "report": str(output_dir / "transport_parity_report.json"),
            "mesh_harness_report": harness_report.artifacts["report"],
            "mesh_harness_events": harness_report.artifacts["events"],
            "mesh_harness_support_bundle": harness_report.artifacts["support_bundle"],
        },
        "secrets_redacted": True,
    }
    report_path = output_dir / "transport_parity_report.json"
    report_path.write_text(json.dumps(_redact(report), indent=2, sort_keys=True), encoding="utf-8")
    return report


def _run_gate_command(
    command: GateCommand,
    output_dir: Path,
    command_runner: Callable[[GateCommand, Path], CommandResult] | None,
) -> CommandResult:
    if command_runner is not None:
        return command_runner(command, output_dir)

    log_dir = output_dir / "commands"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"{command.command_id}.log"
    completed = subprocess.run(
        command.command,
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
                    f"$ {' '.join(command.command)}",
                    f"returncode={completed.returncode}",
                    completed.stdout,
                    completed.stderr,
                ]
            )
        ),
        encoding="utf-8",
    )
    return CommandResult(
        command_id=command.command_id,
        owner=command.owner,
        command=list(command.command),
        status="pass" if completed.returncode == 0 else "fail",
        artifact_path=str(log_path),
        returncode=completed.returncode,
        rationale=command.rationale,
    )


def _not_run_result(command: GateCommand) -> CommandResult:
    return CommandResult(
        command_id=command.command_id,
        owner=command.owner,
        command=list(command.command),
        status="not_run",
        artifact_path=None,
        rationale=command.rationale,
    )


def _build_rows(
    harness_report: HarnessReport,
    command_results: Sequence[CommandResult],
) -> list[MatrixRow]:
    harness_rows = [_row_from_harness_mode(harness_report, mode["mode_id"]) for mode in harness_report.modes]
    command_map = {result.command_id: result for result in command_results}
    harness_by_id = {row.row_id: row for row in harness_rows}

    sdk_build = command_map["sdk_build"]
    for row_id in ("http_gateway_thin_client", "tauri_local_native", "mesh_webrtc"):
        row = harness_by_id[row_id]
        row.commands.append(_format_command(sdk_build.command))
        _merge_command_status(row, sdk_build)

    desktop = harness_by_id["tauri_local_native"]
    desktop.commands.extend(
        [
            _format_command(command_map["tauri_local_smoke"].command),
            "pnpm --filter @aurora/tauri-ui build",
        ]
    )
    _merge_command_status(desktop, command_map["tauri_local_smoke"])

    http = harness_by_id["http_gateway_thin_client"]
    http.commands.append(_format_command(command_map["sdk_conformance"].command))
    _merge_command_status(http, command_map["sdk_conformance"])

    ui_command = command_map["ui_flow_smoke"]
    for row_id in ("thread_localbus", "http_gateway_thin_client", "tauri_local_native", "mesh_webrtc"):
        row = harness_by_id[row_id]
        row.commands.append(_format_command(ui_command.command))
        _merge_command_status(row, ui_command)

    android = _mobile_row(command_map["android_release_gate"])
    ios = _ios_row()
    return [
        harness_by_id["thread_localbus"],
        harness_by_id["process_bullmq_redis"],
        harness_by_id["http_gateway_thin_client"],
        harness_by_id["tauri_local_native"],
        harness_by_id["mesh_webrtc"],
        android,
        ios,
    ]


def _row_from_harness_mode(harness_report: HarnessReport, mode_id: str) -> MatrixRow:
    mode = next(mode for mode in harness_report.modes if mode["mode_id"] == mode_id)
    results = [result for result in harness_report.results if result["mode_id"] == mode_id]
    statuses = {result["status"] for result in results}
    if statuses == {"pass"}:
        status = "pass"
        blocks_release = False
        rationale = "All required harness scenarios passed for this transport."
    elif "fail" in statuses:
        status = "fail"
        blocks_release = True
        rationale = "At least one required harness scenario failed for this transport."
    elif statuses == {"dependency_gap"}:
        status = "skipped-with-rationale"
        blocks_release = True
        rationale = "Live dependency was unavailable; this row must be rerun in an environment with its required runtime."
    else:
        status = "blocked"
        blocks_release = True
        rationale = f"Mixed harness statuses: {sorted(statuses)}"

    return MatrixRow(
        row_id=mode_id,
        label=mode["label"],
        owner=_owner_for_mode(mode_id),
        status=status,
        commands=[
            f"uv run python scripts/mesh_gap_e2e_harness.py --mode {mode_id}",
        ],
        artifact_paths=[
            harness_report.artifacts["report"],
            harness_report.artifacts["events"],
            harness_report.artifacts["support_bundle"],
        ],
        coverage=_coverage_for_mode(mode_id),
        blocks_release=blocks_release,
        rationale=rationale,
        evidence={
            "result_count": len(results),
            "passed": sum(1 for result in results if result["status"] == "pass"),
            "dependency_gap": sum(1 for result in results if result["status"] == "dependency_gap"),
            "failed": sum(1 for result in results if result["status"] == "fail"),
            "transport": mode["transport"],
            "bus": mode["bus"],
        },
    )


def _mobile_row(android_command: CommandResult) -> MatrixRow:
    emulator_smoke_path = Path("apps/aurora-tauri/reports/android-emulator-smoke.json")
    has_emulator_smoke = emulator_smoke_path.exists()
    status = "pass" if android_command.status == "pass" and has_emulator_smoke else "skipped-with-rationale"
    blocks_release = status != "pass"
    return MatrixRow(
        row_id="android_thin_local_light",
        label="Android thin/local-light",
        owner="mobile",
        status=status,
        commands=[_format_command(android_command.command), "pnpm --filter @aurora/tauri-ui android:smoke"],
        artifact_paths=[
            path
            for path in [
                android_command.artifact_path,
                "apps/aurora-tauri/reports/android-release-gate.json",
                str(emulator_smoke_path) if has_emulator_smoke else None,
            ]
            if path
        ],
        coverage=[
            "native capability manifest",
            "thin gateway routing",
            "local-light availability",
            "assistant-role fallback",
            "permission denied state",
        ],
        blocks_release=blocks_release,
        rationale=(
            "Android release-gate and emulator smoke evidence exist."
            if status == "pass"
            else "Android SDK/emulator/device evidence is environment-gated; release-gate output is attached when available, but run the listed smoke command on an Android-capable runner."
        ),
        evidence={
            "command_status": android_command.status,
            "emulator_smoke_attached": has_emulator_smoke,
            "platform": "android",
        },
    )


def _ios_row() -> MatrixRow:
    macos = platform.system().lower() == "darwin"
    status = "skipped-with-rationale"
    return MatrixRow(
        row_id="ios_thin_local_light",
        label="iOS thin/local-light",
        owner="mobile",
        status=status,
        commands=[
            "pnpm --filter @aurora/tauri-ui tauri ios build --target aarch64-sim --config src-tauri/tauri.ios.conf.json",
            "swift .github/scripts/ios_app_intent_smoke.swift",
            "swift .github/scripts/ios_entrypoint_payload_smoke.swift",
        ],
        artifact_paths=["GitHub Actions: Tauri iOS Baseline workflow artifacts"],
        coverage=[
            "native capability manifest",
            "thin gateway routing",
            "local-light availability",
            "App Intents/Shortcuts handoff",
            "permission denied state",
        ],
        blocks_release=True,
        rationale=(
            "This runner is macOS-capable but iOS build evidence was not attached to this local gate run."
            if macos
            else "iOS simulator/build evidence requires a macOS/Xcode runner; run the Tauri iOS Baseline workflow."
        ),
        evidence={"platform": "ios", "runner": platform.system()},
    )


def _merge_command_status(row: MatrixRow, result: CommandResult) -> None:
    if result.artifact_path:
        row.artifact_paths.append(result.artifact_path)
    row.evidence.setdefault("command_results", {})[result.command_id] = result.status
    if result.status == "fail":
        row.status = "fail"
        row.blocks_release = True
        row.rationale = f"{row.rationale} Command {result.command_id} failed."
    elif result.status == "not_run" and row.status == "pass":
        row.status = "blocked"
        row.blocks_release = True
        row.rationale = f"{row.rationale} Command {result.command_id} was not run in this gate invocation."


def _build_summary(
    rows: Sequence[MatrixRow],
    command_results: Sequence[CommandResult],
    harness_report: HarnessReport,
) -> dict[str, Any]:
    blocking_rows = [row.row_id for row in rows if row.blocks_release]
    failed_rows = [row.row_id for row in rows if row.status == "fail"]
    skipped_rows = [row.row_id for row in rows if row.status == "skipped-with-rationale"]
    not_run_required = [
        result.command_id
        for result in command_results
        if result.status == "not_run"
        and next(command for command in GATE_COMMANDS if command.command_id == result.command_id).required_for_release
    ]
    status = "pass"
    if failed_rows:
        status = "fail"
    elif blocking_rows or not_run_required or harness_report.summary["status"] == "blocked":
        status = "blocked"
    return {
        "status": status,
        "row_count": len(rows),
        "passed_rows": [row.row_id for row in rows if row.status == "pass"],
        "failed_rows": failed_rows,
        "skipped_with_rationale_rows": skipped_rows,
        "blocking_rows": sorted(set(blocking_rows + not_run_required)),
        "mock_only_evidence_passed": any(result.command_id == "sdk_conformance" and result.status == "pass" for result in command_results),
        "mock_only_evidence_sufficient": False,
        "mesh_final_proof": harness_report.summary["final_mesh_mode_status"],
        "process_redis_dependency_gap": "process_bullmq_redis" in harness_report.summary["dependency_gap_modes"],
        "secrets_redacted": True,
    }


def _owner_for_mode(mode_id: str) -> str:
    return {
        "thread_localbus": "backend",
        "process_bullmq_redis": "backend/ops",
        "http_gateway_thin_client": "sdk",
        "tauri_local_native": "desktop",
        "mesh_webrtc": "mesh",
    }[mode_id]


def _coverage_for_mode(mode_id: str) -> list[str]:
    common = [
        "registry",
        "capability catalog",
        "route explain",
        "aggregate tools",
        "approval",
        "AdminAction boundary",
        "event stream",
        "diagnostics",
        "audit receipt",
    ]
    extras = {
        "thread_localbus": ["LocalBus request/reply", "assistant basics"],
        "process_bullmq_redis": ["BullMQBus", "Redis request/reply", "Docker/process mode smoke"],
        "http_gateway_thin_client": ["Gateway HTTP routes", "native-only degraded state"],
        "tauri_local_native": ["Tauri command bridge", "offline fallback", "sidecar crash boundary"],
        "mesh_webrtc": ["two-peer WebRTC DataChannel", "remote approval", "provider provenance"],
    }
    return common + extras[mode_id]


def _format_command(command: Sequence[str]) -> str:
    return " ".join(command)


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: ("[redacted]" if _is_sensitive_key(key) and key != "secrets_redacted" else _redact(item))
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_redact(item) for item in value]
    if isinstance(value, str):
        return _redact_text(value)
    return value


def _redact_text(value: str) -> str:
    if "redis://" in value or "/home/" in value or "secret-token" in value:
        return "[redacted]"
    return value


def _is_sensitive_key(key: str) -> bool:
    lowered = key.lower()
    return any(fragment in lowered for fragment in SENSITIVE_KEY_FRAGMENTS)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=REPORT_ROOT)
    parser.add_argument(
        "--execute-commands",
        action="store_true",
        help="Run SDK/UI/native command gates instead of recording them as not_run.",
    )
    args = parser.parse_args()
    report = run_transport_parity_gate(
        output_dir=args.output_dir,
        execute_commands=args.execute_commands,
    )
    print(json.dumps(report["summary"], indent=2, sort_keys=True))
    return 0 if report["summary"]["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
