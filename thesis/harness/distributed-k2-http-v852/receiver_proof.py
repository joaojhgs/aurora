"""Offline K2 receiver proof assembler; reads retained rows and never starts a service."""
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

def _identity(path: Path, expected: dict[str, Any]) -> tuple[dict[str, Any], dict[str, str]]:
    raw = json.loads(_read(path, 64 * 1024))
    provider = raw.get("provider") if isinstance(raw, dict) else None
    files = raw.get("actual_provider_files") if isinstance(raw, dict) else None
    if (provider != expected or type(raw.get("receiver_pid")) is not int
            or raw["receiver_pid"] <= 0 or not isinstance(files, dict)):
        raise ValueError("actual_receiver_identity_mismatch")
    if not HEX.fullmatch(str(files.get("source_receipt_sha256", ""))):
        raise ValueError("receiver_source_receipt_missing")
    canonical: dict[str, str] = {}
    for key, expected_key in (("model", "model_sha256"), ("config", "config_sha256")):
        item = files.get(key)
        if not isinstance(item, dict) or not isinstance(item.get("canonical_path"), str):
            raise ValueError("actual_provider_file_identity_missing")
        path_value = item["canonical_path"]
        if item.get("sha256") != expected[expected_key] or _file_hash(path_value) != expected[expected_key]:
            raise ValueError("actual_provider_file_hash_mismatch")
        canonical[key] = str(Path(path_value).resolve(strict=True))
    return raw, canonical

def build_proof(*, attempts_dir: Path, stage_path: Path, bindings_path: Path,
                assistant_identity_path: Path, tts_identity_path: Path,
                candidate_sha: str, cohort_sha: str,
                expected_receivers: dict[str, Any]) -> dict[str, Any]:
    if not HEX.fullmatch(candidate_sha) or not HEX.fullmatch(cohort_sha):
        raise ValueError("manifest_pin_invalid")
    if set(expected_receivers) != {"assistant", "tts"}:
        raise ValueError("receiver_manifest_invalid")
    identities: dict[str, dict[str, Any]] = {}
    paths: dict[str, dict[str, str]] = {}
    for stage, identity_path in (("assistant", assistant_identity_path), ("tts", tts_identity_path)):
        identities[stage], paths[stage] = _identity(identity_path, expected_receivers[stage])
    spans, span_bytes = _rows(stage_path, 64 * 1024 * 1024)
    bindings, binding_bytes = _rows(bindings_path, 16 * 1024 * 1024)
    # V430 reports the remote LLM as stage=llm and preserves the actual async span ID.
    groups: dict[tuple[str, str], dict[str, list[dict[str, Any]]]] = {}
    for row in spans:
        stage = "assistant" if row.get("stage") == "llm" and row.get("handler") == "resolved_chat_model.astream" else row.get("stage")
        if stage not in {"assistant", "tts"} or row.get("record_kind") != "invocation_span_boundary":
            continue
        corr = row.get("correlation_id")
        if isinstance(corr, str):
            groups.setdefault((stage, corr), {}).setdefault(str(row.get("event")), []).append(row)
    starts = [row for row in bindings if row.get("event") == "piper_cli_call_start"]
    ends = [row for row in bindings if row.get("event") == "piper_cli_call_return"]
    if len(starts) != 15 or len(ends) != 15:
        raise ValueError("actual_piper_call_denominator_mismatch")
    for row in starts:
        args = row.get("actualArguments", {})
        voice = args.get("voice", {}) if isinstance(args, dict) else {}
        if (args.get("useCuda") is not False or voice.get("model_file") != paths["tts"]["model"]
                or voice.get("config_file") != paths["tts"]["config"]):
            raise ValueError("actual_piper_arguments_mismatch")
    calls: list[dict[str, Any]] = []
    used_piper_starts: set[int] = set()
    used_piper_ends: set[int] = set()
    seen_server: set[tuple[str, str]] = set()
    pids: dict[str, int] = {}
    for ordinal in range(1, 16):
        case_id = f"audio-campaign-v847-{ordinal:04d}"
        attempt = json.loads(_read(attempts_dir / f"attempt-{ordinal:04d}-warmup.jsonl", 2 * 1024 * 1024))
        local_id = attempt.get("correlation", {}).get("correlation_id")
        if (attempt.get("harness_case_id") != case_id or attempt.get("phase") != "warmup"
                or attempt.get("status") != "completed_correct"
                or attempt.get("correctness", {}).get("all_expected") is not True
                or not isinstance(local_id, str) or not MAX_ID.fullmatch(local_id)):
            raise ValueError("requester_warmup_not_complete")
        for stage, handler in (("assistant", "resolved_chat_model.astream"), ("tts", "tts.model_invoke")):
            attempt_stage = attempt.get("stages", {}).get(stage, {})
            server_id = attempt_stage.get("server_correlation_id")
            request_sha = attempt_stage.get("request_payload_sha256")
            if (attempt_stage.get("status") != "completed" or not isinstance(server_id, str)
                    or not MAX_ID.fullmatch(server_id) or not isinstance(request_sha, str)
                    or not HEX.fullmatch(request_sha) or (stage, server_id) in seen_server):
                raise ValueError("requester_stage_binding_invalid")
            group = groups.get((stage, server_id), {})
            start_rows = [r for r in group.get("span_start", []) if r.get("outcome") == "started"]
            end_rows = [r for r in group.get("span_end", []) if r.get("outcome") == "completed"]
            if len(start_rows) != 1 or len(end_rows) != 1:
                raise ValueError("receiver_native_span_missing_or_ambiguous")
            begin, finish = start_rows[0], end_rows[0]
            pid = identities[stage]["receiver_pid"]
            if (begin.get("receiver_pid") != pid or finish.get("receiver_pid") != pid
                    or begin.get("correlation_id") != server_id or finish.get("correlation_id") != server_id
                    or begin.get("span_id") != finish.get("span_id")
                    or begin.get("handler") != handler or finish.get("handler") != handler
                    or begin.get("clock_domain") != "python_process_monotonic"
                    or finish.get("clock_domain") != "python_process_monotonic"
                    or not isinstance(begin.get("monotonic_ns"), str)
                    or not isinstance(finish.get("monotonic_ns"), str)):
                raise ValueError("receiver_native_span_identity_mismatch")
            start_ns, end_ns = int(begin["monotonic_ns"]), int(finish["monotonic_ns"])
            if start_ns <= 0 or end_ns <= start_ns:
                raise ValueError("receiver_native_span_clock_invalid")
            record: dict[str, Any] = {
                "stage": stage, "harness_case_id": case_id, "local_correlation_id": local_id,
                "server_correlation_id": server_id, "native_correlation_id": server_id,
                "request_payload_sha256": request_sha, "handler": handler, "outcome": "completed",
                "native_span_id": finish["span_id"], "receiver_pid": pid,
                "receiver_id": expected_receivers[stage]["receiver_id"],
                "provider_identity": expected_receivers[stage],
            }
            if stage == "assistant":
                if (begin.get("operation_id") is not None or finish.get("operation_id") is not None
                        or begin.get("attempt_id") is not None or finish.get("attempt_id") is not None):
                    raise ValueError("assistant_native_ids_unexpected")
                # V430's actual async LLM span has span_id but no operation/attempt IDs.
                record.update(operation_id=None, attempt_id=None,
                              native_id_absence_reason="v430_async_span_exposes_span_id_only")
                llm_rows = [r for r in bindings if r.get("event") == "llm_constructor_return"
                            and r.get("pid") == pid]
                model_path = paths["assistant"]["model"]
                if not any(
                    isinstance(r.get("actualArguments"), dict)
                    and str(Path(str(r["actualArguments"].get("model_path", ""))).resolve(strict=False)) == model_path
                    and isinstance(r.get("returned"), dict)
                    and r["returned"].get("class") == expected_receivers[stage]["provider_class"]
                    for r in llm_rows
                ):
                    raise ValueError("actual_assistant_constructor_binding_missing")
            else:
                if (begin.get("operation_id") != finish.get("operation_id")
                        or begin.get("attempt_id") != finish.get("attempt_id")):
                    raise ValueError("tts_native_ids_mismatch")
                op, att = finish.get("operation_id"), finish.get("attempt_id")
                if not all(isinstance(v, str) and MAX_ID.fullmatch(v) for v in (op, att)):
                    raise ValueError("tts_native_ids_missing")
                record.update(operation_id=op, attempt_id=att)
                starts_match = [(i, r) for i, r in enumerate(starts) if i not in used_piper_starts
                    and r.get("pid") == pid and type(r.get("monotonicNs")) is int
                    and start_ns <= r["monotonicNs"] <= end_ns]
                ends_match = [(i, r) for i, r in enumerate(ends) if i not in used_piper_ends
                    and r.get("pid") == pid and type(r.get("monotonicNs")) is int
                    and start_ns <= r["monotonicNs"] <= end_ns]
                if len(starts_match) != 1 or len(ends_match) != 1:
                    raise ValueError("tts_piper_call_not_uniquely_paired")
                used_piper_starts.add(starts_match[0][0]); used_piper_ends.add(ends_match[0][0])
                actual = starts_match[0][1].get("actualArguments", {})
                voice = actual.get("voice", {}) if isinstance(actual, dict) else {}
                if (voice.get("model_file") != paths["tts"]["model"]
                        or voice.get("config_file") != paths["tts"]["config"]
                        or actual.get("useCuda") is not False):
                    raise ValueError("tts_actual_provider_binding_mismatch")
            calls.append(record)
            seen_server.add((stage, server_id))
            pids[stage] = pid
    if len(calls) != 30 or len(used_piper_starts) != 15 or len(used_piper_ends) != 15:
        raise ValueError("remote_stage_denominator_mismatch")
    return {
        "schema": "aurora.distributed_k2_remote_stages_warmup.v1",
        "candidate_manifest_sha256": candidate_sha, "cohort_manifest_sha256": cohort_sha,
        "receivers": expected_receivers, "calls": calls,
        "native_id_semantics": {
            "assistant": "V430 resolved_chat_model.astream carries span_id; operation_id and attempt_id are null by source contract",
            "tts": "native operation_id and attempt_id required",
            "request_payload_sha256": "Gateway requester body only; not augmented LLM input hash",
        },
        "evidence_sha256": {"stages": _sha(span_bytes), "bindings": _sha(binding_bytes)},
    }

def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    for name in ("attempts-dir", "receiver-stages", "provider-bindings", "assistant-identity", "tts-identity", "output"):
        p.add_argument("--" + name, type=Path, required=True)
    p.add_argument("--candidate-manifest-sha256", required=True)
    p.add_argument("--cohort-manifest-sha256", required=True)
    p.add_argument("--expected-receivers", type=Path, required=True)
    a = p.parse_args()
    expected = json.loads(_read(a.expected_receivers, 64 * 1024))
    proof = build_proof(attempts_dir=a.attempts_dir, stage_path=a.receiver_stages,
        bindings_path=a.provider_bindings, assistant_identity_path=a.assistant_identity,
        tts_identity_path=a.tts_identity, candidate_sha=a.candidate_manifest_sha256,
        cohort_sha=a.cohort_manifest_sha256, expected_receivers=expected)
    if a.output.is_symlink() or a.output.exists():
        raise SystemExit("proof_output_exists_or_symlinked")
    data = (json.dumps(proof, sort_keys=True, separators=(",", ":")) + "\n").encode()
    fd = os.open(a.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data); stream.flush(); os.fsync(stream.fileno())
    print(json.dumps({"status": "receiver_proof_written", "calls": 30, "sha256": _sha(data)}))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
