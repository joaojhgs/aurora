"""One-shot, offline K1 receiver proof assembler; never starts a service."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any

MAX_JSONL_BYTES = 64 * 1024 * 1024
MAX_ID = re.compile(r"^[A-Za-z0-9._:-]{1,160}$")


def _read_regular(path: Path, cap: int = MAX_JSONL_BYTES) -> bytes:
    if path.is_symlink() or not path.is_file():
        raise ValueError("input_missing_or_symlinked")
    if path.stat().st_size > cap:
        raise ValueError("input_size_cap")
    return path.read_bytes()


def _jsonl(data: bytes) -> list[dict[str, Any]]:
    rows = []
    for line in data.splitlines():
        row = json.loads(line)
        if not isinstance(row, dict):
            raise ValueError("jsonl_row_not_object")
        rows.append(row)
    return rows


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _integer(value: Any) -> int | None:
    if type(value) is int:
        return value
    if isinstance(value, str) and value.isascii() and value.isdecimal() and len(value) <= 24:
        return int(value)
    return None


def build_proof(*, attempts_dir: Path, stage_path: Path, bindings_path: Path,
                identity_path: Path, candidate_sha: str, expected: dict[str, Any]) -> dict[str, Any]:
    if not re.fullmatch(r"[0-9a-f]{64}", candidate_sha):
        raise ValueError("candidate_manifest_pin_invalid")
    identity = json.loads(_read_regular(identity_path, 64 * 1024))
    provider = identity.get("provider") if isinstance(identity, dict) else None
    actual_files = identity.get("actual_provider_files") if isinstance(identity, dict) else None
    if (not isinstance(provider, dict) or provider != expected
            or type(identity.get("receiver_pid")) is not int or identity["receiver_pid"] <= 0):
        raise ValueError("actual_receiver_identity_mismatch")
    if not isinstance(actual_files, dict):
        raise ValueError("actual_provider_file_identity_missing")
    receipt_sha = actual_files.get("source_receipt_sha256")
    if not isinstance(receipt_sha, str) or not re.fullmatch(r"[0-9a-f]{64}", receipt_sha):
        raise ValueError("actual_provider_file_receipt_missing")
    admitted_paths: dict[str, str] = {}
    for kind, provider_key in (("model", "model_sha256"), ("config", "config_sha256")):
        item = actual_files.get(kind)
        expected_sha = expected.get(provider_key)
        if (not isinstance(item, dict)
                or not isinstance(expected_sha, str)
                or not re.fullmatch(r"[0-9a-f]{64}", expected_sha)
                or item.get("sha256") != expected_sha):
            raise ValueError("actual_provider_file_hash_mismatch")
        canonical_path = item.get("canonical_path")
        if (not isinstance(canonical_path, str) or not Path(canonical_path).is_absolute()
                or ".." in Path(canonical_path).parts):
            raise ValueError("actual_provider_file_path_invalid")
        admitted_paths[kind] = canonical_path
    spans = _jsonl(_read_regular(stage_path))
    bindings = _jsonl(_read_regular(bindings_path, 16 * 1024 * 1024))
    span_groups: dict[str, dict[str, list[dict[str, Any]]]] = {}
    for row in spans:
        corr = row.get("correlation_id")
        if (row.get("record_kind") == "invocation_span_boundary" and row.get("stage") == "tts"
                and row.get("handler") == "tts.model_invoke" and isinstance(corr, str)):
            span_groups.setdefault(corr, {}).setdefault(row.get("event", ""), []).append(row)
    starts = [row for row in bindings if row.get("event") == "piper_cli_call_start"]
    ends = [row for row in bindings if row.get("event") == "piper_cli_call_return"]
    if len(starts) != 15 or len(ends) != 15:
        raise ValueError("actual_piper_call_count_mismatch")
    for row in starts:
        args = row.get("actualArguments", {})
        voice = args.get("voice", {}) if isinstance(args, dict) else {}
        if (args.get("useCuda") is not False or not isinstance(args.get("piperExecutable"), str)
                or voice.get("model_file") != admitted_paths["model"]
                or voice.get("config_file") != admitted_paths["config"]):
            raise ValueError("actual_piper_arguments_incomplete")
    calls: list[dict[str, Any]] = []
    used_starts: set[int] = set()
    used_ends: set[int] = set()
    seen_server: set[str] = set()
    for ordinal in range(1, 16):
        case_id = f"audio-campaign-v2220-{ordinal:04d}"
        attempt_path = attempts_dir / f"attempt-{ordinal:04d}-warmup.jsonl"
        attempt_data = _read_regular(attempt_path, 2 * 1024 * 1024)
        attempt = json.loads(attempt_data)
        correlation = attempt.get("correlation", {}).get("correlation_id")
        stage = attempt.get("stages", {}).get("tts", {})
        server = stage.get("server_correlation_id")
        request_hash = stage.get("request_text_sha256")
        if (attempt.get("harness_case_id") != case_id or attempt.get("phase") != "warmup"
                or attempt.get("status") != "completed_correct"
                or attempt.get("correctness", {}).get("all_expected") is not True
                or not isinstance(correlation, str) or not MAX_ID.fullmatch(correlation)
                or not isinstance(server, str) or not MAX_ID.fullmatch(server)
                or not isinstance(request_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", request_hash)
                or server in seen_server):
            raise ValueError("requester_warmup_binding_incomplete")
        group = span_groups.get(server, {})
        span_start = [r for r in group.get("span_start", []) if r.get("outcome") in (None, "started")]
        span_end = [r for r in group.get("span_end", []) if r.get("outcome") == "completed"]
        if len(span_start) != 1 or len(span_end) != 1:
            raise ValueError("receiver_tts_span_missing_or_ambiguous")
        begin, finish = span_start[0], span_end[0]
        if (begin.get("receiver_pid") != identity["receiver_pid"]
                or finish.get("receiver_pid") != identity["receiver_pid"]
                or begin.get("operation_id") != finish.get("operation_id")
                or begin.get("attempt_id") != finish.get("attempt_id")
                or not isinstance(begin.get("monotonic_ns"), str)
                or not isinstance(finish.get("monotonic_ns"), str)):
            raise ValueError("receiver_span_identity_mismatch")
        start_ns, end_ns = int(begin["monotonic_ns"]), int(finish["monotonic_ns"])
        if start_ns <= 0 or end_ns <= start_ns:
            raise ValueError("receiver_span_clock_invalid")
        matching_start = [(i, r) for i, r in enumerate(starts) if i not in used_starts
                          and r.get("pid") == identity["receiver_pid"]
                          and (stamp := _integer(r.get("monotonicNs"))) is not None
                          and start_ns <= stamp <= end_ns]
        matching_end = [(i, r) for i, r in enumerate(ends) if i not in used_ends
                        and r.get("pid") == identity["receiver_pid"]
                        and (stamp := _integer(r.get("monotonicNs"))) is not None
                        and start_ns <= stamp <= end_ns]
        if len(matching_start) != 1 or len(matching_end) != 1:
            raise ValueError("receiver_piper_call_not_uniquely_inside_native_span")
        used_starts.add(matching_start[0][0])
        used_ends.add(matching_end[0][0])
        start_args = matching_start[0][1].get("actualArguments", {})
        start_voice = start_args.get("voice", {}) if isinstance(start_args, dict) else {}
        if (start_voice.get("model_file") != admitted_paths["model"]
                or start_voice.get("config_file") != admitted_paths["config"]
                or start_args.get("useCuda") is not False):
            raise ValueError("actual_piper_call_binding_mismatch")
        operation_id, attempt_id = finish.get("operation_id"), finish.get("attempt_id")
        if not all(isinstance(x, str) and MAX_ID.fullmatch(x) for x in (operation_id, attempt_id)):
            raise ValueError("receiver_operation_identity_missing")
        calls.append({
            "harness_case_id": case_id, "local_correlation_id": correlation,
            "server_correlation_id": server, "native_correlation_id": server,
            "request_text_sha256": request_hash, "handler": "tts.model_invoke",
            "outcome": "completed", "operation_id": operation_id,
            "attempt_id": attempt_id, "receiver_pid": identity["receiver_pid"],
            "provider": provider,
        })
        seen_server.add(server)
    if len(used_starts) != 15 or len(used_ends) != 15:
        raise ValueError("receiver_provider_call_denominator_mismatch")
    return {
        "schema": "aurora.distributed_k1_tts_warmup.v1",
        "candidate_manifest_sha256": candidate_sha,
        "receiver_pid": identity["receiver_pid"], "provider": provider,
        "actual_provider_file_sha256": {
            "model": actual_files["model"]["sha256"],
            "config": actual_files["config"]["sha256"],
        },
        "calls": calls,
        "evidence_sha256": {
            "stage_rows": _sha(_read_regular(stage_path)),
            "provider_bindings": _sha(_read_regular(bindings_path, 16 * 1024 * 1024)),
            "receiver_identity": _sha(_read_regular(identity_path, 64 * 1024)),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--attempts-dir", type=Path, required=True)
    parser.add_argument("--receiver-stages", type=Path, required=True)
    parser.add_argument("--provider-bindings", type=Path, required=True)
    parser.add_argument("--receiver-identity", type=Path, required=True)
    parser.add_argument("--candidate-manifest-sha256", required=True)
    parser.add_argument("--expected-provider-json", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    expected = json.loads(_read_regular(args.expected_provider_json, 64 * 1024))
    proof = build_proof(attempts_dir=args.attempts_dir, stage_path=args.receiver_stages,
                        bindings_path=args.provider_bindings, identity_path=args.receiver_identity,
                        candidate_sha=args.candidate_manifest_sha256, expected=expected)
    output = args.output
    if output.is_symlink() or output.exists():
        raise SystemExit("proof_output_exists_or_symlinked")
    encoded = (json.dumps(proof, sort_keys=True, separators=(",", ":")) + "\n").encode()
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(encoded)
        stream.flush()
        os.fsync(stream.fileno())
    print(json.dumps({"status": "receiver_proof_written", "calls": 15,
                      "output_sha256": _sha(encoded)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
