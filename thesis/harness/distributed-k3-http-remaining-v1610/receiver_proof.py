"""Offline proof assembler for the 15 K3 remote-stage warmups.

This reads already retained requester, receiver-span, provider-binding, and
identity artifacts. It never starts a service or sends a request.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any

MAX_ID = re.compile(r"^[A-Za-z0-9._:-]{1,160}$")
HEX = re.compile(r"^[0-9a-f]{64}$")
STAGES = ("stt", "assistant", "tts")
HANDLERS = {
    "stt": "stt.model_invoke",
    "assistant": "resolved_chat_model.astream",
    "tts": "tts.model_invoke",
}


def _read(path: Path, cap: int) -> bytes:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > cap:
        raise ValueError("input_missing_symlinked_or_oversized")
    return path.read_bytes()


def _rows(path: Path, cap: int) -> tuple[list[dict[str, Any]], bytes]:
    data = _read(path, cap)
    rows = [json.loads(line) for line in data.splitlines()]
    if any(not isinstance(row, dict) for row in rows):
        raise ValueError("jsonl_row_invalid")
    return rows, data


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _file_hash(path: str) -> str:
    candidate = Path(path)
    if not candidate.is_absolute() or candidate.is_symlink() or not candidate.is_file():
        raise ValueError("provider_file_unavailable")
    digest = hashlib.sha256()
    with candidate.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _identity(path: Path, stage: str, expected: dict[str, Any]) -> tuple[dict[str, Any], dict[str, str]]:
    raw = json.loads(_read(path, 64 * 1024))
    provider = raw.get("provider") if isinstance(raw, dict) else None
    files = raw.get("actual_provider_files") if isinstance(raw, dict) else None
    if provider != expected or type(raw.get("receiver_pid")) is not int or raw["receiver_pid"] <= 0:
        raise ValueError("actual_receiver_identity_mismatch")
    if not isinstance(files, dict) or not HEX.fullmatch(str(files.get("source_receipt_sha256", ""))):
        raise ValueError("receiver_source_receipt_missing")
    canonical: dict[str, str] = {}
    file_bindings = [("model", "model_sha256"), ("config", "config_sha256")]
    if stage == "stt":
        directory = expected.get("constructor_directory")
        directory_path = Path(str(directory))
        item = files.get("model_directory")
        if (not isinstance(directory, str) or not directory_path.is_absolute()
                or str(directory_path) != directory or directory_path.is_symlink()
                or not directory_path.is_dir() or directory_path.resolve(strict=True) != directory_path
                or not isinstance(item, dict)
                or item.get("canonical_path") != directory):
            raise ValueError("actual_stt_constructor_directory_mismatch")
        canonical["constructor_directory"] = str(directory_path.resolve(strict=True))
        file_bindings.append(("tokenizer", "tokenizer_sha256"))
        file_bindings.append(("vocabulary", "vocabulary_sha256"))
    for key, expected_key in file_bindings:
        item = files.get(key)
        if not isinstance(item, dict) or not isinstance(item.get("canonical_path"), str):
            raise ValueError("actual_provider_file_identity_missing")
        value = item["canonical_path"]
        if item.get("sha256") != expected[expected_key] or _file_hash(value) != expected[expected_key]:
            raise ValueError("actual_provider_file_hash_mismatch")
        member_path = Path(value)
        resolved = member_path.resolve(strict=True)
        if member_path != resolved:
            raise ValueError("actual_provider_file_path_not_canonical")
        if stage == "stt":
            expected_name = {
                "model": "model.bin", "config": "config.json",
                "tokenizer": "tokenizer.json", "vocabulary": "vocabulary.txt",
            }[key]
            if resolved.parent != Path(canonical["constructor_directory"]) or resolved.name != expected_name:
                raise ValueError("actual_stt_member_outside_constructor_directory")
        canonical[key] = str(resolved)
    return raw, canonical


def _constructor_matches(stage: str, identity: dict[str, Any], paths: dict[str, str],
                         bindings: list[dict[str, Any]]) -> bool:
    receiver = identity["provider"]
    pid = identity["receiver_pid"]
    if stage == "stt":
        events = [row for row in bindings if row.get("event") == "stt_constructor_return"
                  and row.get("pid") == pid]
        return any(
            isinstance(row.get("actualArguments"), dict)
            and row["actualArguments"].get("model") == paths["constructor_directory"]
            and isinstance(row.get("returned"), dict)
            and row["returned"].get("class") == receiver["provider_class"]
            and isinstance(row.get("engine"), dict)
            for row in events
        )
    if stage == "assistant":
        events = [row for row in bindings if row.get("event") == "llm_constructor_return"
                  and row.get("pid") == pid]
        return any(
            isinstance(row.get("actualArguments"), dict)
            and str(Path(str(row["actualArguments"].get("model_path", ""))).resolve(strict=False))
                == paths["model"]
            and isinstance(row.get("returned"), dict)
            and row["returned"].get("class") == receiver["provider_class"]
            for row in events
        )
    return True


def build_proof(*, attempts_dir: Path, stage_path: Path, bindings_path: Path,
                identity_paths: dict[str, Path], candidate_sha: str, cohort_sha: str,
                expected_receivers: dict[str, Any]) -> dict[str, Any]:
    if not HEX.fullmatch(candidate_sha) or not HEX.fullmatch(cohort_sha):
        raise ValueError("manifest_pin_invalid")
    if set(expected_receivers) != set(STAGES) or set(identity_paths) != set(STAGES):
        raise ValueError("receiver_manifest_invalid")
    identities: dict[str, dict[str, Any]] = {}
    paths: dict[str, dict[str, str]] = {}
    for stage in STAGES:
        identities[stage], paths[stage] = _identity(identity_paths[stage], stage, expected_receivers[stage])

    spans, span_bytes = _rows(stage_path, 64 * 1024 * 1024)
    bindings, binding_bytes = _rows(bindings_path, 16 * 1024 * 1024)
    groups: dict[tuple[str, str], dict[str, list[dict[str, Any]]]] = {}
    for row in spans:
        stage = "assistant" if row.get("stage") == "llm" and row.get("handler") == HANDLERS["assistant"] else row.get("stage")
        if stage not in STAGES or row.get("record_kind") != "invocation_span_boundary":
            continue
        correlation = row.get("correlation_id")
        if isinstance(correlation, str):
            groups.setdefault((stage, correlation), {}).setdefault(str(row.get("event")), []).append(row)

    piper_starts = [row for row in bindings if row.get("event") == "piper_cli_call_start"]
    piper_ends = [row for row in bindings if row.get("event") == "piper_cli_call_return"]
    if len(piper_starts) != 15 or len(piper_ends) != 15:
        raise ValueError("actual_piper_call_denominator_mismatch")
    used_starts: set[int] = set()
    used_ends: set[int] = set()
    calls: list[dict[str, Any]] = []
    seen_server: set[tuple[str, str]] = set()
    pids: dict[str, int] = {}

    for stage in STAGES:
        if not _constructor_matches(stage, identities[stage], paths[stage], bindings):
            raise ValueError(f"actual_{stage}_constructor_binding_missing")

    for ordinal in range(1, 16):
        case_id = f"audio-campaign-v1610-{ordinal:04d}"
        attempt = json.loads(_read(attempts_dir / f"attempt-{ordinal:04d}-warmup.jsonl", 2 * 1024 * 1024))
        local_id = attempt.get("correlation", {}).get("correlation_id")
        if (attempt.get("harness_case_id") != case_id or attempt.get("phase") != "warmup"
                or attempt.get("status") != "completed_correct"
                or attempt.get("correctness", {}).get("all_expected") is not True
                or not isinstance(local_id, str) or not MAX_ID.fullmatch(local_id)):
            raise ValueError("requester_warmup_not_complete")
        for stage in STAGES:
            row = attempt.get("stages", {}).get(stage, {})
            server_id = row.get("server_correlation_id")
            request_sha = row.get("request_payload_sha256")
            if (row.get("status") != "completed" or not isinstance(server_id, str)
                    or not MAX_ID.fullmatch(server_id) or not isinstance(request_sha, str)
                    or not HEX.fullmatch(request_sha) or (stage, server_id) in seen_server):
                raise ValueError("requester_remote_stage_binding_invalid")
            group = groups.get((stage, server_id), {})
            starts = [item for item in group.get("span_start", []) if item.get("outcome") == "started"]
            ends = [item for item in group.get("span_end", []) if item.get("outcome") == "completed"]
            if len(starts) != 1 or len(ends) != 1:
                raise ValueError("receiver_native_span_missing_or_ambiguous")
            begin, finish = starts[0], ends[0]
            receiver = expected_receivers[stage]
            pid = identities[stage]["receiver_pid"]
            if (begin.get("receiver_pid") != pid or finish.get("receiver_pid") != pid
                    or begin.get("correlation_id") != server_id or finish.get("correlation_id") != server_id
                    or begin.get("span_id") != finish.get("span_id")
                    or begin.get("handler") != HANDLERS[stage] or finish.get("handler") != HANDLERS[stage]
                    or begin.get("clock_domain") != "python_process_monotonic"
                    or finish.get("clock_domain") != "python_process_monotonic"
                    or not isinstance(begin.get("monotonic_ns"), str)
                    or not isinstance(finish.get("monotonic_ns"), str)):
                raise ValueError("receiver_native_span_identity_mismatch")
            start_ns, end_ns = int(begin["monotonic_ns"]), int(finish["monotonic_ns"])
            if start_ns <= 0 or end_ns <= start_ns:
                raise ValueError("receiver_native_span_clock_invalid")
            call: dict[str, Any] = {
                "stage": stage, "harness_case_id": case_id,
                "local_correlation_id": local_id, "server_correlation_id": server_id,
                "native_correlation_id": server_id, "request_payload_sha256": request_sha,
                "handler": HANDLERS[stage], "outcome": "completed",
                "native_span_id": finish["span_id"], "receiver_pid": pid,
                "receiver_id": receiver["receiver_id"], "provider_identity": receiver,
            }
            if stage == "assistant":
                if (begin.get("operation_id") is not None or finish.get("operation_id") is not None
                        or begin.get("attempt_id") is not None or finish.get("attempt_id") is not None):
                    raise ValueError("assistant_native_ids_unexpected")
                call.update(operation_id=None, attempt_id=None,
                            native_id_absence_reason="v430_async_span_exposes_span_id_only")
            else:
                operation_id, attempt_id = finish.get("operation_id"), finish.get("attempt_id")
                if (begin.get("operation_id") != operation_id or begin.get("attempt_id") != attempt_id
                        or not isinstance(operation_id, str) or not MAX_ID.fullmatch(operation_id)
                        or not isinstance(attempt_id, str) or not MAX_ID.fullmatch(attempt_id)):
                    raise ValueError(f"{stage}_native_ids_missing_or_mismatched")
                call.update(operation_id=operation_id, attempt_id=attempt_id)
            if stage == "tts":
                starts_match = [(i, item) for i, item in enumerate(piper_starts) if i not in used_starts
                    and item.get("pid") == pid and type(item.get("monotonicNs")) is int
                    and start_ns <= item["monotonicNs"] <= end_ns]
                ends_match = [(i, item) for i, item in enumerate(piper_ends) if i not in used_ends
                    and item.get("pid") == pid and type(item.get("monotonicNs")) is int
                    and start_ns <= item["monotonicNs"] <= end_ns]
                if len(starts_match) != 1 or len(ends_match) != 1:
                    raise ValueError("tts_piper_call_not_uniquely_paired")
                used_starts.add(starts_match[0][0]); used_ends.add(ends_match[0][0])
                args = starts_match[0][1].get("actualArguments", {})
                voice = args.get("voice", {}) if isinstance(args, dict) else {}
                if (args.get("useCuda") is not False
                        or str(Path(str(voice.get("model_file", ""))).resolve(strict=False)) != paths["tts"]["model"]
                        or str(Path(str(voice.get("config_file", ""))).resolve(strict=False)) != paths["tts"]["config"]):
                    raise ValueError("tts_actual_provider_binding_mismatch")
            calls.append(call)
            seen_server.add((stage, server_id))
            pids[stage] = pid
    if len(calls) != 45 or len(used_starts) != 15 or len(used_ends) != 15:
        raise ValueError("remote_stage_denominator_mismatch")
    return {
        "schema": "aurora.distributed_k3_remote_stages_warmup.v1",
        "candidate_manifest_sha256": candidate_sha,
        "cohort_manifest_sha256": cohort_sha,
        "receivers": expected_receivers,
        "calls": calls,
        "native_id_semantics": {
            "assistant": "V430 resolved_chat_model.astream carries span_id; operation_id and attempt_id are null by source contract",
            "request_payload_sha256": "Gateway requester body only; not augmented LLM input hash",
        },
        "evidence_sha256": {"stages": _sha(span_bytes), "bindings": _sha(binding_bytes)},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--attempts-dir", type=Path, required=True)
    parser.add_argument("--receiver-stages", type=Path, required=True)
    parser.add_argument("--provider-bindings", type=Path, required=True)
    for stage in STAGES:
        parser.add_argument(f"--{stage}-identity", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--candidate-manifest-sha256", required=True)
    parser.add_argument("--cohort-manifest-sha256", required=True)
    parser.add_argument("--expected-receivers", type=Path, required=True)
    args = parser.parse_args()
    expected = json.loads(_read(args.expected_receivers, 64 * 1024))
    proof = build_proof(
        attempts_dir=args.attempts_dir, stage_path=args.receiver_stages,
        bindings_path=args.provider_bindings,
        identity_paths={stage: getattr(args, f"{stage}_identity") for stage in STAGES},
        candidate_sha=args.candidate_manifest_sha256,
        cohort_sha=args.cohort_manifest_sha256, expected_receivers=expected,
    )
    if args.output.is_symlink() or args.output.exists():
        raise SystemExit("proof_output_exists_or_symlinked")
    data = (json.dumps(proof, sort_keys=True, separators=(",", ":")) + "\n").encode()
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data); stream.flush(); os.fsync(stream.fileno())
    print(json.dumps({"status": "receiver_proof_written", "calls": 45, "sha256": _sha(data)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
