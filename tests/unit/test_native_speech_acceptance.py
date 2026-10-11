from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

import pytest

from scripts.validate_native_speech_acceptance import AcceptanceError, validate_record


def _write(root: Path, relative: str, data: bytes) -> str:
    target = root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    return hashlib.sha256(data).hexdigest()


def _git(root: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(root), *args], check=True, capture_output=True, text=True
    ).stdout.strip()


def _accepted_repo(tmp_path: Path) -> tuple[Path, Path, dict]:
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init")
    _git(repo, "checkout", "-b", "integration")
    _git(repo, "config", "user.name", "Acceptance Test")
    _git(repo, "config", "user.email", "acceptance@example.invalid")

    plan_hash = _write(
        repo,
        ".omx/plans/native-speech-routing-2026-09-05/contracts.md",
        b"fixed acceptance plan\n",
    )
    inventory_hash = _write(
        repo,
        "packages/aurora-sdk/src/generated/backend-contracts.manifest.json",
        b'{"generator_format_version":"aurora-sdk-zod-codegen-v1"}\n',
    )
    _write(
        repo,
        "docs/security/mesh-security-surface-inventory.json",
        b'{"methods":[{"bus_topic":"Speech.StreamStart","source":{"file":"src/speech.py"},"handler":"run"}]}\n',
    )
    schema_artifacts = {}
    for name, path in {
        "node_config": "rust/crates/aurora-voice-core/src/node_policy.rs",
        "speech_session": "app/shared/contracts/models/speech_runtime.py",
        "capability": "app/shared/contracts/models/speech_runtime.py",
        "observer": "app/shared/contracts/models/speech_runtime.py",
    }.items():
        schema_artifacts[name] = {
            "file": path,
            "sha256": _write(repo, path, f"wire source for {path}\n".encode()),
        }
    source_hash = _write(repo, "src/speech.py", b"def run(): return True\n")
    _git(repo, "add", ".")
    _git(repo, "commit", "-m", "integrated speech implementation")
    commit = _git(repo, "rev-parse", "HEAD")
    unit_hash = _write(repo, "artifacts/unit.json", b'{"result":"passed"}\n')
    ocr_hash = _write(repo, "reviews/ocr.md", b"approved after fixes\n")
    architecture_hash = _write(repo, "reviews/architecture.md", b"approved after fixes\n")

    record = {
        "schema_version": "native-speech-routing-acceptance.v1",
        "issue": "PER-286",
        "status": "accepted",
        "integrated_commit": commit,
        "integration_branch": "integration",
        "plan_sha256": plan_hash,
        "schemas": {"node_config": 2, "speech_session": 1, "capability": 1, "observer": 1},
        "schema_artifacts": schema_artifacts,
        "inventory_sha256": inventory_hash,
        "source_map": [
            {
                "stage": "stt",
                "methods_or_events": ["Speech.StreamStart"],
                "file": "src/speech.py",
                "symbols": ["run"],
                "generated_inventory_version": "aurora-sdk-zod-codegen-v1",
                "source_sha256": source_hash,
            }
        ],
        "capability_matrix": [
            {
                "surface": "native",
                "role": "mesh-node",
                "stage": "stt",
                "direction": "host",
                "placement": ["local"],
                "finite": True,
                "streaming": True,
                "lifecycle_eligibility": "foreground",
                "required_gate": "PER286-LIVE-001",
                "implemented": "native",
                "build": "passed",
                "live": "passed",
            }
        ],
        "required_gates": [],
        "optional_limitations": [],
        "evidence": [],
        "reviews": {
            "ocr": {
                "verdict": "approved",
                "reviewer": "reviewer-one",
                "artifact_path": "reviews/ocr.md",
                "artifact_sha256": ocr_hash,
                "commit": commit,
                "after_fixes": True,
            },
            "architecture_security": {
                "verdict": "approved",
                "reviewer": "reviewer-two",
                "artifact_path": "reviews/architecture.md",
                "artifact_sha256": architecture_hash,
                "commit": commit,
                "after_fixes": True,
            },
        },
    }
    unit_gates = [
        f"PER286-{family}"
        for family in ("CONTRACT", "CONFIG", "ROUTE", "STREAM", "NATIVE", "UI", "OBS")
    ]
    live_gates = ["PER286-LIVE-001", "PER286-LIVE-004", "PER286-LIVE-006"]
    live_facts = {
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
    for gate_id in unit_gates + live_gates:
        is_live = gate_id in live_gates
        evidence_id = f"evidence-{gate_id}"
        if is_live:
            scenario, platform_class, facts = live_facts[gate_id]
            artifact_path = f"artifacts/{gate_id}.json"
            platform = f"test {platform_class}"
            runtime_hash = _write(
                repo,
                artifact_path,
                json.dumps(
                    {
                        "gate_id": gate_id,
                        "scenario": scenario,
                        "integrated_commit": commit,
                        "exit_code": 0,
                        "command": "run acceptance",
                        "platform_class": platform_class,
                        "platform": platform,
                        "model_identity": {"format": "sha256", "digest": "a" * 64},
                        "assertions": dict.fromkeys(facts, True),
                    },
                    sort_keys=True,
                ).encode()
                + b"\n",
            )
            artifact_hash = runtime_hash
        else:
            artifact_path = "artifacts/unit.json"
            artifact_hash = unit_hash
            platform = "test device"
        record["required_gates"].append(
            {
                "gate_id": gate_id,
                "status": "passed_runtime" if is_live else "passed",
                "command": "run acceptance",
                "exit_code": 0,
                "notes": "passed",
                "evidence_ids": [evidence_id],
            }
        )
        record["evidence"].append(
            {
                "evidence_id": evidence_id,
                "kind": "runtime" if is_live else "unit",
                "command": "run acceptance",
                "exit_code": 0,
                "commit": commit,
                "artifact_sha256": artifact_hash,
                "artifact_path": artifact_path,
                "device_os_browser": platform,
                "model_digest_format": "sha256" if is_live else None,
                "scenario": live_facts[gate_id][0] if is_live else gate_id,
                "classification": "fresh",
                "skipped_assertions": "none",
                "gate_ids": [gate_id],
            }
        )
    for gate_id in live_gates[1:]:
        record["capability_matrix"].append(
            {
                "surface": "native",
                "role": "mesh-node",
                "stage": gate_id,
                "direction": "host",
                "placement": ["local"],
                "finite": True,
                "streaming": True,
                "lifecycle_eligibility": "foreground",
                "required_gate": gate_id,
                "implemented": "native",
                "build": "passed",
                "live": "passed",
            }
        )
    record_path = tmp_path / "acceptance.json"
    record_path.write_text(json.dumps(record), encoding="utf-8")
    return repo, record_path, record


def test_pending_record_is_valid_without_claiming_acceptance(tmp_path: Path) -> None:
    repo = Path(__file__).resolve().parents[2]
    record = tmp_path / "pending.json"
    record.write_text(
        json.dumps(
            {
                "schema_version": "native-speech-routing-acceptance.v1",
                "issue": "PER-286",
                "status": "pending",
                "integrated_commit": None,
                "integration_branch": None,
                "plan_sha256": None,
                "schemas": {"node_config": 2, "speech_session": 1, "capability": 1, "observer": 1},
                "inventory_sha256": None,
                "source_map": [],
                "capability_matrix": [],
                "required_gates": [],
                "optional_limitations": [],
                "evidence": [],
                "reviews": {"ocr": None, "architecture_security": None},
            }
        ),
        encoding="utf-8",
    )

    parsed = validate_record(record, repo)

    assert parsed["status"] == "pending"
    with pytest.raises(AcceptanceError, match="pending"):
        validate_record(record, repo, require_accepted=True)


def test_structurally_accepted_but_unbacked_record_is_rejected(tmp_path: Path) -> None:
    repo, record_path, record = _accepted_repo(tmp_path)
    record["integrated_commit"] = None
    record_path.write_text(json.dumps(record), encoding="utf-8")

    with pytest.raises(AcceptanceError, match="integrated commit"):
        validate_record(record_path, repo, require_accepted=True)


def test_valid_accepted_record_checks_git_artifacts_and_reviews(tmp_path: Path) -> None:
    repo, record_path, _ = _accepted_repo(tmp_path)

    assert validate_record(record_path, repo, require_accepted=True)["status"] == "accepted"


@pytest.mark.parametrize(
    "mutation, message",
    [
        ("hash", "SHA-256 mismatch"),
        ("ancestry", "not an ancestor"),
        ("source_evidence", "evidence kind does not match required gate"),
        ("missing_gate", "omits mandatory gates"),
        ("wrong_scenario", "runtime artifact does not substantiate required gate"),
    ],
)
def test_acceptance_rejects_tampered_or_nonruntime_evidence(
    tmp_path: Path, mutation: str, message: str
) -> None:
    repo, record_path, record = _accepted_repo(tmp_path)
    if mutation == "hash":
        record["evidence"][0]["artifact_sha256"] = "0" * 64
    elif mutation == "ancestry":
        _git(repo, "checkout", "--orphan", "unrelated")
        _git(repo, "rm", "-rf", ".")
        _write(repo, "unrelated.txt", b"unrelated\n")
        _git(repo, "add", "unrelated.txt")
        _git(repo, "commit", "-m", "unrelated history")
        record["integrated_commit"] = _git(repo, "rev-parse", "HEAD")
    elif mutation == "wrong_scenario":
        runtime = next(
            item for item in record["evidence"] if item["evidence_id"] == "evidence-PER286-LIVE-001"
        )
        runtime["scenario"] = "wrong scenario"
    elif mutation == "source_evidence":
        runtime = next(
            item for item in record["evidence"] if item["evidence_id"] == "evidence-PER286-LIVE-001"
        )
        runtime["kind"] = "source"
    else:
        record["required_gates"] = [
            g for g in record["required_gates"] if g["gate_id"] != "PER286-LIVE-006"
        ]
    record_path.write_text(json.dumps(record), encoding="utf-8")

    with pytest.raises(AcceptanceError, match=message):
        validate_record(record_path, repo, require_accepted=True)


def test_duplicate_json_keys_are_rejected(tmp_path: Path) -> None:
    repo = Path(__file__).resolve().parents[2]
    record = tmp_path / "duplicate.json"
    record.write_text('{"status":"pending","status":"accepted"}', encoding="utf-8")

    with pytest.raises(AcceptanceError, match="duplicate JSON key"):
        validate_record(record, repo)


def test_pending_record_rejects_path_traversal(tmp_path: Path) -> None:
    repo = Path(__file__).resolve().parents[2]
    record = {
        "schema_version": "native-speech-routing-acceptance.v1",
        "issue": "PER-286",
        "status": "pending",
        "integrated_commit": None,
        "integration_branch": None,
        "plan_sha256": None,
        "schemas": {"node_config": 2, "speech_session": 1, "capability": 1, "observer": 1},
        "inventory_sha256": None,
        "source_map": [
            {
                "stage": "stt",
                "methods_or_events": ["Start"],
                "file": "../../outside.py",
                "symbols": ["start"],
                "generated_inventory_version": "inventory-v1",
            }
        ],
        "capability_matrix": [],
        "required_gates": [],
        "optional_limitations": [],
        "evidence": [],
        "reviews": {"ocr": None, "architecture_security": None},
    }
    path = tmp_path / "unsafe.json"
    path.write_text(json.dumps(record), encoding="utf-8")

    with pytest.raises(AcceptanceError):
        validate_record(path, repo)


def test_pending_record_rejects_symlink_escape(tmp_path: Path) -> None:
    repo, record_path, record = _accepted_repo(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    (repo / "escape").symlink_to(outside, target_is_directory=True)
    record["status"] = "pending"
    record["source_map"][0]["file"] = "escape/file.py"
    record_path.write_text(json.dumps(record), encoding="utf-8")

    with pytest.raises(AcceptanceError, match="symlink"):
        validate_record(record_path, repo)
