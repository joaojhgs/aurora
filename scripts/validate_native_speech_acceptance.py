#!/usr/bin/env python3
import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path, PurePosixPath
from typing import Any

from jsonschema import Draft202012Validator

SCHEMA = Path(__file__).resolve().parent / "schemas/native-speech-routing-acceptance.v1.schema.json"
PLAN_PATH = ".omx/plans/native-speech-routing-2026-09-05/contracts.md"
INVENTORY_PATH = "packages/aurora-sdk/src/generated/backend-contracts.manifest.json"
METHOD_INVENTORY_PATH = "docs/security/mesh-security-surface-inventory.json"
SCHEMA_PATHS = {
    "node_config": "rust/crates/aurora-voice-core/src/node_policy.rs",
    "speech_session": "app/shared/contracts/models/speech_runtime.py",
    "capability": "app/shared/contracts/models/speech_runtime.py",
    "observer": "app/shared/contracts/models/speech_runtime.py",
}
UNIT_FAMILIES = {"CONTRACT", "CONFIG", "ROUTE", "STREAM", "NATIVE", "UI", "OBS"}
LIVE_GATES = {"PER286-LIVE-001", "PER286-LIVE-004", "PER286-LIVE-006"}
LIVE_FACTS = {
    "PER286-LIVE-001": (
        "main-py-boundary",
        "python-host",
        {"main_py_executed", "real_gateway_stack", "no_mock_server"},
    ),
    "PER286-LIVE-004": (
        "native-host-finite-and-remote-kws-vad",
        "native-host",
        {
            "native_host_executed",
            "finite_stt",
            "finite_tts",
            "remote_kws_active_session",
            "remote_vad_active_session",
        },
    ),
    "PER286-LIVE-006": (
        "apple-host-ios-stages",
        "apple-host-ios",
        {"ios_runtime_executed", "partial_stage_pack", "foreground_stage_routes"},
    ),
}
HASH = re.compile(r"^[0-9a-f]{64}$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")


class AcceptanceError(ValueError):
    pass


def _unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise AcceptanceError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=_unique)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise AcceptanceError(f"cannot read JSON file {path}: {exc}") from exc


def _git(repo: Path, *args: str) -> str:
    try:
        done = subprocess.run(
            ["git", "-C", str(repo), *args], check=True, capture_output=True, text=True
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise AcceptanceError(f"git verification failed: {' '.join(args)}") from exc
    return done.stdout.strip()


def _rel(value: str) -> PurePosixPath:
    if not value or "\x00" in value or "\\" in value:
        raise AcceptanceError(f"unsafe repository path: {value!r}")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in value.split("/")):
        raise AcceptanceError(f"unsafe repository path: {value!r}")
    return path


def _bytes(repo: Path, value: str, commit: str | None = None) -> bytes:
    rel = _rel(value)
    if commit:
        try:
            return subprocess.run(
                ["git", "-C", str(repo), "show", f"{commit}:{rel.as_posix()}"],
                check=True,
                capture_output=True,
            ).stdout
        except (OSError, subprocess.CalledProcessError) as exc:
            raise AcceptanceError(f"artifact is absent from integrated commit: {value}") from exc
    try:
        path = repo.joinpath(*rel.parts).resolve(strict=True)
        path.relative_to(repo.resolve(strict=True))
        if not path.is_file():
            raise OSError("not a file")
        return path.read_bytes()
    except (OSError, ValueError) as exc:
        raise AcceptanceError(f"repository artifact is unavailable: {value}") from exc


def _check_hash(repo: Path, path: str, expected: str, commit: str | None = None) -> bytes:
    if not HASH.fullmatch(expected):
        raise AcceptanceError(f"invalid SHA-256 for {path}")
    data = _bytes(repo, path, commit)
    if hashlib.sha256(data).hexdigest() != expected:
        raise AcceptanceError(f"SHA-256 mismatch for {path}")
    return data


def _verify_live_artifact(repo: Path, item: dict[str, Any], gate_id: str, command: str) -> None:
    expected = LIVE_FACTS.get(gate_id)
    if expected is None:
        raise AcceptanceError(f"runtime evidence has no canonical scenario definition: {gate_id}")
    scenario, platform, facts = expected
    artifact = _json(repo.joinpath(*_rel(item["artifact_path"]).parts))
    if not isinstance(artifact, dict):
        raise AcceptanceError(f"runtime artifact is not an object: {gate_id}")
    identity = artifact.get("model_identity")
    assertions = artifact.get("assertions")
    if (
        artifact.get("gate_id") != gate_id
        or artifact.get("scenario") != scenario
        or item["scenario"] != scenario
        or artifact.get("integrated_commit") != item["commit"]
        or artifact.get("exit_code") != 0
        or artifact.get("command") != command
        or artifact.get("platform_class") != platform
        or artifact.get("platform") != item["device_os_browser"]
        or not isinstance(identity, dict)
        or identity.get("format") != item["model_digest_format"]
        or identity.get("format") != "sha256"
        or not isinstance(identity.get("digest"), str)
        or not HASH.fullmatch(identity["digest"])
        or not isinstance(assertions, dict)
        or any(assertions.get(fact) is not True for fact in facts)
    ):
        raise AcceptanceError(f"runtime artifact does not substantiate required gate: {gate_id}")


def _validate_accepted(record: dict[str, Any], repo: Path) -> None:
    commit, branch = record["integrated_commit"], record["integration_branch"]
    if not isinstance(commit, str) or not COMMIT.fullmatch(commit):
        raise AcceptanceError("accepted record requires a full integrated commit")
    if not isinstance(branch, str) or not branch or branch.startswith("-"):
        raise AcceptanceError("accepted record requires an integration branch")
    branch = branch.removeprefix("refs/heads/")
    if _git(repo, "check-ref-format", "--branch", branch) != branch:
        raise AcceptanceError("integration branch is invalid")
    ref = f"refs/heads/{branch}"
    _git(repo, "rev-parse", "--verify", "--end-of-options", ref)
    _git(repo, "cat-file", "-e", f"{commit}^{{commit}}")
    try:
        subprocess.run(
            ["git", "-C", str(repo), "merge-base", "--is-ancestor", commit, ref],
            check=True,
            capture_output=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise AcceptanceError(
            "integrated commit is not an ancestor of the selected branch"
        ) from exc
    if record.get("unresolved_mandatory_gaps"):
        raise AcceptanceError("accepted record has unresolved mandatory gaps")
    _check_hash(repo, PLAN_PATH, record.get("plan_sha256") or "")
    inventory = _check_hash(repo, INVENTORY_PATH, record.get("inventory_sha256") or "", commit)
    try:
        version = json.loads(inventory, object_pairs_hook=_unique).get("generator_format_version")
    except (json.JSONDecodeError, AttributeError) as exc:
        raise AcceptanceError("integrated backend inventory is invalid") from exc
    if not isinstance(version, str) or not version:
        raise AcceptanceError("integrated backend inventory has no generator format version")
    method_inventory = json.loads(
        _bytes(repo, METHOD_INVENTORY_PATH, commit), object_pairs_hook=_unique
    )
    methods = {
        (entry.get("bus_topic"), entry.get("source", {}).get("file"), entry.get("handler"))
        for entry in method_inventory.get("methods", [])
    }
    schema_artifacts = record.get("schema_artifacts") or {}
    if set(schema_artifacts) != set(SCHEMA_PATHS):
        raise AcceptanceError("accepted record must pin all four wire schema artifacts")
    for name, expected_path in SCHEMA_PATHS.items():
        artifact = schema_artifacts[name]
        if artifact["file"] != expected_path:
            raise AcceptanceError(f"noncanonical wire schema source for {name}")
        _check_hash(repo, artifact["file"], artifact["sha256"], commit)
    rows = record.get("source_map") or []
    if not rows:
        raise AcceptanceError("accepted record requires a nonempty source map")
    for row in rows:
        path = row["file"]
        data = _check_hash(repo, path, row.get("source_sha256") or "", commit)
        if row["generated_inventory_version"] != version:
            raise AcceptanceError(f"source map inventory version differs: {path}")
        if any(symbol.encode("utf-8") not in data for symbol in row["symbols"]):
            raise AcceptanceError(f"source map symbol is absent from integrated file: {path}")
        for method in row["methods_or_events"]:
            if not any(
                topic == method and source == path and handler in row["symbols"]
                for topic, source, handler in methods
            ):
                raise AcceptanceError(
                    f"source map method is not tied to its pinned handler: {method}"
                )
    gates = record.get("required_gates") or []
    by_gate: dict[str, dict[str, Any]] = {}
    for gate in gates:
        gate_id = gate["gate_id"]
        if gate_id in by_gate:
            raise AcceptanceError(f"duplicate required gate: {gate_id}")
        by_gate[gate_id] = gate
        if gate["status"] not in {"passed", "passed_runtime"} or gate["exit_code"] != 0:
            raise AcceptanceError(f"required gate did not pass: {gate_id}")
    required = {f"PER286-{family}" for family in UNIT_FAMILIES} | LIVE_GATES
    missing = required - by_gate.keys()
    if missing:
        raise AcceptanceError(
            f"accepted record omits mandatory gates: {', '.join(sorted(missing))}"
        )
    evidence: dict[str, dict[str, Any]] = {}
    for item in record.get("evidence", []):
        evidence_id = item.get("evidence_id")
        if not evidence_id or evidence_id in evidence:
            raise AcceptanceError("evidence IDs must be present and unique")
        evidence[evidence_id] = item
        artifact_path, artifact_hash = item.get("artifact_path"), item.get("artifact_sha256")
        if bool(artifact_path) != bool(artifact_hash):
            raise AcceptanceError(
                f"evidence artifact path and hash must appear together: {evidence_id}"
            )
        if artifact_path:
            _check_hash(repo, artifact_path, artifact_hash)
    matrix = record.get("capability_matrix") or []
    if not matrix:
        raise AcceptanceError("accepted record requires a nonempty capability matrix")
    matrix_gates = {row["required_gate"] for row in matrix}
    if not matrix_gates.issuperset(LIVE_GATES):
        raise AcceptanceError("capability matrix omits a mandatory live surface")
    if any(
        row["required_gate"] not in by_gate or row["build"] != "passed" or row["live"] != "passed"
        for row in matrix
    ):
        raise AcceptanceError("capability matrix contains an unverified row or unknown gate")
    runtime_gates = LIVE_GATES | {
        gate_id for gate_id in by_gate if gate_id.startswith("PER286-LIVE-")
    }
    if any(by_gate[gate_id]["status"] != "passed_runtime" for gate_id in runtime_gates):
        raise AcceptanceError("a mandatory live gate is not marked passed_runtime")
    for gate in gates:
        gate_id = gate["gate_id"]
        linked, seen, runtime = gate.get("evidence_ids", []), set(), False
        if not linked:
            raise AcceptanceError(f"required gate has no linked evidence: {gate_id}")
        for evidence_id in linked:
            if evidence_id in seen:
                raise AcceptanceError(f"duplicate evidence link on gate: {gate_id}")
            seen.add(evidence_id)
            item = evidence.get(evidence_id)
            if item is None or item["commit"] != commit or item["exit_code"] != 0:
                raise AcceptanceError(
                    f"evidence is not successful at the integrated revision: {evidence_id}"
                )
            if not gate.get("command") or item.get("command") != gate["command"]:
                raise AcceptanceError(f"gate command does not match evidence: {evidence_id}")
            if item["classification"] != "fresh":
                raise AcceptanceError(
                    f"required gate uses retained or skipped evidence: {evidence_id}"
                )
            if item["skipped_assertions"].strip().lower() not in {"", "none"}:
                raise AcceptanceError(f"required evidence skipped assertions: {evidence_id}")
            if item.get("gate_ids") and gate_id not in item["gate_ids"]:
                raise AcceptanceError(f"evidence does not identify linked gate: {evidence_id}")
            path, digest = item.get("artifact_path"), item.get("artifact_sha256")
            if not path or not digest:
                raise AcceptanceError(f"required evidence artifact is not pinned: {evidence_id}")
            allowed = (
                {"runtime", "platform"} if gate_id in runtime_gates else {"unit", "integration"}
            )
            if item["kind"] not in allowed:
                raise AcceptanceError(f"evidence kind does not match required gate: {evidence_id}")
            if gate_id in runtime_gates:
                _verify_live_artifact(repo, item, gate_id, gate["command"])
            runtime = runtime or gate_id in runtime_gates
        if gate_id in runtime_gates and not runtime:
            raise AcceptanceError(f"runtime gate lacks fresh pinned runtime evidence: {gate_id}")
    reviews = list(record["reviews"].values())
    for name, review in record["reviews"].items():
        if review is None or review["verdict"] != "approved" or not review["after_fixes"]:
            raise AcceptanceError(
                f"required independent review is not approved after fixes: {name}"
            )
        if review["commit"] != commit:
            raise AcceptanceError(f"review is not for the integrated commit: {name}")
        _check_hash(repo, review["artifact_path"], review["artifact_sha256"])
    if reviews[0]["reviewer"].casefold() == reviews[1]["reviewer"].casefold():
        raise AcceptanceError("OCR and architecture/security reviews must be separate reviewers")


def _paths(record: dict[str, Any]) -> list[str]:
    result = [row["file"] for row in record.get("source_map", [])]
    for gate in record.get("required_gates", []):
        result.extend(gate.get("artifacts", []))
    result.extend(
        item["artifact_path"] for item in record.get("evidence", []) if item.get("artifact_path")
    )
    result.extend(
        review["artifact_path"]
        for review in record.get("reviews", {}).values()
        if review is not None
    )
    return result


def validate_record(
    record_path: Path, repo: Path, require_accepted: bool = False
) -> dict[str, Any]:
    record, schema = _json(record_path), _json(SCHEMA)
    Draft202012Validator.check_schema(schema)
    errors = sorted(
        Draft202012Validator(schema).iter_errors(record), key=lambda e: list(e.absolute_path)
    )
    if errors:
        error = errors[0]
        where = ".".join(str(part) for part in error.absolute_path) or "record"
        raise AcceptanceError(f"schema error at {where}: {error.message}")
    repo = repo.resolve(strict=True)
    for value in _paths(record):
        rel = _rel(value)
        try:
            repo.joinpath(*rel.parts).resolve(strict=False).relative_to(repo)
        except ValueError as exc:
            raise AcceptanceError(f"repository path escapes through a symlink: {value}") from exc
    if require_accepted and record["status"] != "accepted":
        raise AcceptanceError("record is pending; accepted status was required")
    if record["status"] == "accepted":
        _validate_accepted(record, repo)
    return record


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("record", type=Path)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--require-accepted", action="store_true")
    args = parser.parse_args(argv)
    try:
        record = validate_record(args.record, args.repo, args.require_accepted)
    except (AcceptanceError, OSError) as exc:
        print(f"invalid native speech acceptance: {exc}", file=sys.stderr)
        return 2
    print(f"valid {record['status']} PER-286 acceptance record")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
