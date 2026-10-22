"""Offline K3 receiver proof assembler; reads retained rows and never starts a service."""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import os
import re
import time
from pathlib import Path
from typing import Any

MAX_ID = re.compile(r"^[A-Za-z0-9._:-]{1,160}$")
HEX = re.compile(r"^[0-9a-f]{64}$")

WARMUP_POLICY = {
    "qualification": "first_15_completed_correct_full_audio_flows",
    "target_correct": 15,
    "maximum_distinct_attempts": 30,
    "maximum_consecutive_preaccept_rejections": 3,
    "continuable_failure": "preaccept_capability_changed",
    "failed_attempt_retry": False,
    "measured_attempts": 900,
    "measured_retry": False,
    "all_warmup_attempts_and_failures_retained": True,
}


def known_preaccept_failure(row: dict[str, Any]) -> bool:
    """Recognize an explicit non-executed rejection, never a quality failure."""
    failure = row.get("failure", {})
    stage = failure.get("stage")
    response = row.get("stages", {}).get(stage, {}).get("preaccept_response", {})
    return bool(
        row.get("status") == "failed"
        and failure.get("code") == "preaccept_capability_changed"
        and stage in {"stt", "assistant", "tts"}
        and row.get("timeout") is not True
        and row.get("partial_quality_incorrect") is not True
        and response.get("accepted") is False
        and response.get("reason_code") == "capability_changed"
        and response.get("correlation_id") == row.get("correlation", {}).get("correlation_id")
    )


def qualified_warmup_records(attempts_dir: Path, *, require_complete: bool = True) -> dict[str, Any]:
    """Select the prefrozen first 15 successes and retain every failed attempt.

    Physical ordinals, case IDs, correlations and source bytes are never changed.
    The only continuable failure is a structured preaccept rejection. The next
    iteration is a distinct request; no failed request is resubmitted.
    """
    records: list[dict[str, Any]] = []
    selected: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    consecutive = 0
    for path in sorted(attempts_dir.glob("attempt-*-warmup.jsonl")):
        match = re.fullmatch(r"attempt-([0-9]{4})-warmup\.jsonl", path.name)
        if match is None:
            raise ValueError("warmup_filename_invalid")
        raw = _read(path, 2 * 1024 * 1024)
        row = json.loads(raw)
        ordinal = int(match.group(1))
        if (ordinal != len(records) + 1 or row.get("ordinal") != ordinal
                or row.get("phase_index") != ordinal or row.get("phase") != "warmup"
                or row.get("harness_case_id") != f"audio-campaign-v1910-{ordinal:04d}"
                or len(records) >= 30 or len(selected) >= 15):
            raise ValueError("warmup_order_or_frozen_budget_invalid")
        item = {"ordinal": ordinal, "path": path, "row": row, "sha256": _sha(raw)}
        records.append(item)
        if row.get("status") == "completed_correct":
            if (row.get("correctness", {}).get("all_expected") is not True
                    or any(row.get("stages", {}).get(stage, {}).get("status") != "completed"
                           for stage in ("stt", "assistant", "tts"))
                    or not isinstance(row.get("output_audio"), dict)):
                raise ValueError("warmup_correctness_or_audio_missing")
            selected.append(item)
            consecutive = 0
        elif known_preaccept_failure(row):
            rejected.append(item)
            consecutive += 1
            if consecutive >= 3:
                raise ValueError("three_consecutive_preaccept_capability_rejections")
        else:
            raise ValueError("non_preaccept_warmup_failure_preserved_hard_stop")
    if require_complete and len(selected) != 15:
        raise ValueError("fifteen_correct_remote_audio_flows_required")
    return {"all": records, "selected": selected, "rejected": rejected,
            "attempted": len(records), "correct": len(selected), "failed": len(rejected),
            "qualified_ordinals": [item["ordinal"] for item in selected]}


def warmup_qualification_receipt(selection: dict[str, Any]) -> dict[str, Any]:
    return {"policy": WARMUP_POLICY,
            "attempted_excluded": selection["attempted"],
            "completed_correct_excluded": selection["correct"],
            "failed_preaccept_excluded": selection["failed"],
            "qualified_ordinals": selection["qualified_ordinals"],
            "failed_ordinals": [item["ordinal"] for item in selection["rejected"]],
            "all_raw_case_sha256": {item["path"].name: item["sha256"] for item in selection["all"]}}

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

def _await_mesh_route_warmups(rows_path: Path, status_path: Path) -> tuple[list[dict[str, Any]], bytes, bytes, dict[str, Any]]:
    deadline = time.monotonic() + 20.0
    while time.monotonic() < deadline:
        try:
            status_bytes = _read(status_path, 64 * 1024)
            status = json.loads(status_bytes)
            route_rows, route_bytes = _rows(rows_path, 64 * 1024 * 1024)
            if (isinstance(status, dict) and status.get("state") == "accepting"
                    and status.get("complete") is False
                    and 45 <= status.get("accepted_rows", -1) <= 90
                    and status.get("written_rows") == status.get("accepted_rows")
                    and len(route_rows) == status.get("written_rows")):
                return route_rows, route_bytes, status_bytes, status
        except (OSError, ValueError, json.JSONDecodeError):
            pass
        time.sleep(0.1)
    raise ValueError("mesh_route_warmup_observations_not_flushed_within_bound")

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
                assistant_identity_path: Path, tts_identity_path: Path, stt_identity_path: Path,
                mesh_calls_path: Path, route_observations_path: Path,
                route_sink_status_path: Path, route_runtime_pins_path: Path,
                frozen_manifest_path: Path,
                candidate_sha: str, cohort_sha: str,
                expected_receivers: dict[str, Any]) -> dict[str, Any]:
    if not HEX.fullmatch(candidate_sha) or not HEX.fullmatch(cohort_sha):
        raise ValueError("manifest_pin_invalid")
    if set(expected_receivers) != {"stt", "assistant", "tts"}:
        raise ValueError("receiver_manifest_invalid")
    if any(not isinstance(expected_receivers.get(stage), dict) for stage in ("stt", "assistant", "tts")):
        raise ValueError("receiver_manifest_invalid")
    identities: dict[str, dict[str, Any]] = {}
    paths: dict[str, dict[str, str]] = {}
    for stage, identity_path in (("stt", stt_identity_path), ("assistant", assistant_identity_path), ("tts", tts_identity_path)):
        identities[stage], paths[stage] = _identity(identity_path, expected_receivers[stage])
    spans, span_bytes = _rows(stage_path, 64 * 1024 * 1024)
    bindings, binding_bytes = _rows(bindings_path, 16 * 1024 * 1024)
    mesh_calls, mesh_call_bytes = _rows(mesh_calls_path, 32 * 1024 * 1024)
    route_rows, route_bytes, route_status_bytes, route_status = _await_mesh_route_warmups(
        route_observations_path, route_sink_status_path)
    route_runtime_bytes = _read(route_runtime_pins_path, 256 * 1024)
    route_runtime = json.loads(route_runtime_bytes)
    cohort_bytes = _read(frozen_manifest_path, 256 * 1024)
    if _sha(cohort_bytes) != cohort_sha:
        raise ValueError("frozen_manifest_hash_mismatch")
    cohort = json.loads(cohort_bytes)
    frozen_implementation = cohort.get("implementation", {})
    if cohort.get("warmupReadinessPolicy") != WARMUP_POLICY:
        raise ValueError("warmup_readiness_policy_not_frozen")
    qualification = qualified_warmup_records(attempts_dir)
    all_correlations = {item["row"]["correlation"]["correlation_id"] for item in qualification["all"]}
    selected_correlations = {item["row"]["correlation"]["correlation_id"] for item in qualification["selected"]}
    if (any(row.get("correlation_id") not in all_correlations for row in route_rows)
            or any(row.get("correlation_id") not in all_correlations for row in mesh_calls)):
        raise ValueError("unattributed_warmup_route_or_call_row")
    selected_route_count = sum(row.get("correlation_id") in selected_correlations for row in route_rows)
    selected_mesh_call_count = sum(row.get("correlation_id") in selected_correlations for row in mesh_calls)
    if selected_route_count != 45 or selected_mesh_call_count != 90:
        raise ValueError("qualified_warmup_route_call_count_invalid")
    if (cohort.get("remoteReceivers") != expected_receivers
            or expected_receivers.get("stt", {}).get("peer_id_sha256") != cohort.get("meshSttPeerIdSha256")
            or expected_receivers.get("assistant", {}).get("peer_id_sha256") != cohort.get("meshAssistantPeerIdSha256")
            or expected_receivers.get("tts", {}).get("peer_id_sha256") != cohort.get("meshTtsPeerIdSha256")
            or cohort.get("meshAuthorityBinding") != "existing_authorized_peer_session"):
        raise ValueError("frozen_mesh_receiver_binding_mismatch")
    if (not 45 <= len(route_rows) <= 90
            or route_status.get("schema") != "aurora.mesh_route_observation_sink.v1"
            or route_status.get("state") != "accepting" or route_status.get("complete") is not False
            or route_status.get("accepted_rows") != len(route_rows) or route_status.get("written_rows") != len(route_rows)
            or any(route_status.get(key) != 0 for key in ("dropped_rows", "oversize_rows", "quota_rows", "invalid_rows"))
            or route_status.get("writer_error_class") is not None
            or route_runtime.get("schema") != "aurora.mesh_route_runtime_install.v1"
            or route_runtime.get("status") != "verified_before_observer_install"
            or route_runtime.get("frozen_manifest_sha256") != cohort_sha
            or route_runtime.get("route_observer_sha256") != frozen_implementation.get("routeObserverSha256")
            or route_runtime.get("route_sink_sha256") != frozen_implementation.get("routeSinkSha256")
            or route_runtime.get("runtime_pins_sha256") != frozen_implementation.get("routeRuntimePinsSha256")
            or route_runtime.get("observation_limit") != "before_after_snapshots_all_pc_transports_no_pair_id_no_continuous_stability"):
        raise ValueError("mesh_route_warmup_observation_gate_incomplete")
    topics = {"stt": "Transcription.Transcribe", "assistant": "Orchestrator.ExternalUserInput", "tts": "TTS.Synthesize"}
    rejected_stage_keys = {(item["row"]["failure"]["stage"], item["row"]["correlation"]["correlation_id"])
                           for item in qualification["rejected"]}
    routes: dict[tuple[str, str], dict[str, Any]] = {}
    for row in route_rows:
        stage = next((key for key, topic in topics.items() if row.get("topic") == topic), None)
        corr = row.get("correlation_id")
        if (stage is None or not isinstance(corr, str) or not corr or row.get("request_outcome") != ("failed" if (stage, corr) in rejected_stage_keys else "ok")
                or type(row.get("requester_pid")) is not int
                or type(row.get("request_monotonic_start_ns")) is not int
                or type(row.get("request_monotonic_end_ns")) is not int
                or row["request_monotonic_end_ns"] <= row["request_monotonic_start_ns"]
                or not isinstance(row.get("before"), dict) or not isinstance(row.get("after"), dict)
                or (stage, corr) in routes):
            raise ValueError("mesh_route_observation_row_invalid")
        routes[(stage, corr)] = row
    mesh_calls_by_key: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for row in mesh_calls:
        stage = next((s for s, topic in topics.items() if row.get("topic") == topic), None)
        corr = row.get("correlation_id")
        if stage is None or not isinstance(corr, str):
            raise ValueError("requester_mesh_call_row_invalid")
        mesh_calls_by_key.setdefault((stage, corr), []).append(row)
    # V430 reports the remote LLM as stage=llm and preserves the actual async span ID.
    groups: dict[tuple[str, str], dict[str, list[dict[str, Any]]]] = {}
    for row in spans:
        stage = "assistant" if row.get("stage") == "llm" and row.get("handler") == "resolved_chat_model.astream" else row.get("stage")
        if stage not in {"stt", "assistant", "tts"} or row.get("record_kind") != "invocation_span_boundary":
            continue
        if stage == "stt" and row.get("handler") != "stt.model_invoke":
            continue
        if stage == "tts" and row.get("handler") != "tts.model_invoke":
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
    for qualified in qualification["selected"]:
        ordinal = qualified["ordinal"]
        case_id = f"audio-campaign-v1910-{ordinal:04d}"
        attempt = json.loads(_read(attempts_dir / f"attempt-{ordinal:04d}-warmup.jsonl", 2 * 1024 * 1024))
        local_id = attempt.get("correlation", {}).get("correlation_id")
        if (attempt.get("harness_case_id") != case_id or attempt.get("phase") != "warmup"
                or attempt.get("status") != "completed_correct"
                or attempt.get("correctness", {}).get("all_expected") is not True
                or not isinstance(local_id, str) or not MAX_ID.fullmatch(local_id)):
            raise ValueError("requester_warmup_not_complete")
        for stage, handler in (("stt", "stt.model_invoke"), ("assistant", "resolved_chat_model.astream"), ("tts", "tts.model_invoke")):
            attempt_stage = attempt.get("stages", {}).get(stage, {})
            server_id = attempt_stage.get("mesh_correlation_id")
            request_sha = attempt_stage.get("request_payload_sha256")
            if (attempt_stage.get("status") != "completed" or not isinstance(server_id, str)
                    or not MAX_ID.fullmatch(server_id) or not isinstance(request_sha, str)
                    or not HEX.fullmatch(request_sha) or (stage, server_id) in seen_server
                    or server_id != local_id):
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
                "mesh_correlation_id": server_id, "native_correlation_id": server_id,
                "request_payload_sha256": request_sha, "handler": handler, "outcome": "completed",
                "native_span_id": finish["span_id"], "receiver_pid": pid,
                "receiver_id": expected_receivers[stage]["receiver_id"],
                "provider_identity": expected_receivers[stage],
            }
            peer_hash = expected_receivers[stage].get("peer_id_sha256")
            mesh_pair = mesh_calls_by_key.get((stage, server_id), [])
            route_row = routes.get((stage, server_id))
            mesh_starts = [r for r in mesh_pair if r.get("event") == "mesh_peer_call_start"]
            mesh_ends = [r for r in mesh_pair if r.get("event") == "mesh_peer_call_end"]
            mesh_call = mesh_ends[0] if len(mesh_ends) == 1 else {}
            mesh_start = mesh_starts[0] if len(mesh_starts) == 1 else {}
            before = route_row.get("before") if route_row else None
            after = route_row.get("after") if route_row else None
            def valid_snapshot(snapshot: Any) -> bool:
                pairs = snapshot.get("selected_pairs") if isinstance(snapshot, dict) else None
                return (isinstance(pairs, list) and 0 < len(pairs) <= 32
                        and all(isinstance(pair, dict)
                                and pair.get("nominated") is True
                                and pair.get("pair_state") == "succeeded"
                                and pair.get("path_class") in ("direct", "relay")
                                for pair in pairs))
            if (not isinstance(peer_hash, str) or not HEX.fullmatch(peer_hash)
                    or len(mesh_pair) != 2 or len(mesh_starts) != 1 or len(mesh_ends) != 1
                    or route_row is None
                    or mesh_start.get("peer_id_sha256") != peer_hash
                    or mesh_call.get("peer_id_sha256") != peer_hash
                    or mesh_call.get("outcome") != "ok"
                    or mesh_start.get("pid") != route_row.get("requester_pid")
                    or mesh_call.get("pid") != route_row.get("requester_pid")
                    or mesh_start.get("topic") != topics[stage]
                    or mesh_call.get("topic") != topics[stage]
                    or mesh_start.get("correlation_id") != server_id
                    or mesh_call.get("correlation_id") != server_id
                    or mesh_call.get("monotonic_start_ns") != mesh_start.get("monotonic_start_ns")
                    or type(mesh_call.get("monotonic_end_ns")) is not int
                    or mesh_call["monotonic_end_ns"] <= mesh_start.get("monotonic_start_ns", 0)
                    or route_row.get("topic") != topics[stage]
                    or mesh_start.get("monotonic_start_ns") < route_row.get("request_monotonic_start_ns", 0)
                    or mesh_call.get("monotonic_end_ns") > route_row.get("request_monotonic_end_ns", 0)
                    or not isinstance(before, dict) or not isinstance(after, dict)
                    or not valid_snapshot(before) or not valid_snapshot(after)
                    or any(snap.get("status") != "selected_nominated_pair_observed"
                           or snap.get("pid") != route_row.get("requester_pid")
                           or snap.get("peer_id_sha256") != peer_hash
                           or not isinstance(snap.get("session_peer_id_sha256"), str)
                           or not HEX.fullmatch(snap.get("session_peer_id_sha256", ""))
                           or not isinstance(snap.get("peer_connection_instance_sha256"), str)
                           or not HEX.fullmatch(snap.get("peer_connection_instance_sha256", ""))
                           for snap in (before, after))
                    or before.get("session_peer_id_sha256") != after.get("session_peer_id_sha256")
                    or before.get("peer_connection_instance_sha256") != after.get("peer_connection_instance_sha256")):
                raise ValueError("exact_peer_route_call_join_missing")
            record["exact_peer_route"] = {
                "peer_id_sha256": peer_hash,
                "requester_mesh_call_pid": mesh_call.get("pid"),
                "route_observation_before": route_row["before"].get("status"),
                "route_observation_after": route_row["after"].get("status"),
                "session_peer_id_sha256": before.get("session_peer_id_sha256"),
                "peer_connection_instance_sha256": before.get("peer_connection_instance_sha256"),
                "before_path_classes": sorted({pair["path_class"] for pair in before["selected_pairs"]}),
                "after_path_classes": sorted({pair["path_class"] for pair in after["selected_pairs"]}),
                "snapshot_scope": "before_after_snapshots_all_pc_transports_no_pair_id_no_continuous_stability",
                "continuous_route_stability_claimed": False,
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
                expected_settings = cohort.get("remoteAssistantConfigBinding", {}).get(
                    "effective_llm_settings", {}
                )
                settings_keys = {
                    "model_path", "n_gpu_layers", "n_ctx", "n_batch", "n_threads", "temperature",
                    "max_tokens", "seed", "top_p", "top_k", "repeat_penalty", "min_p", "chat_format",
                }
                integer_settings = {
                    "n_gpu_layers", "n_ctx", "n_batch", "n_threads", "max_tokens", "seed", "top_k",
                }
                decimal_settings = {"temperature", "top_p", "repeat_penalty", "min_p"}
                if (not isinstance(expected_settings, dict) or set(expected_settings) != settings_keys
                        or not isinstance(expected_settings.get("model_path"), str)
                        or not expected_settings["model_path"]
                        or not isinstance(expected_settings.get("chat_format"), str)
                        or not expected_settings["chat_format"]
                        or any(type(expected_settings.get(key)) is not int for key in integer_settings)
                        or any(type(expected_settings.get(key)) not in (int, float)
                               or not math.isfinite(expected_settings[key]) for key in decimal_settings)):
                    raise ValueError("frozen_assistant_effective_settings_invalid")
                if not any(
                    isinstance(r.get("actualArguments"), dict)
                    and str(Path(str(r["actualArguments"].get("model_path", ""))).resolve(strict=False)) == model_path
                    and {key: r["actualArguments"].get(key) for key in settings_keys} == expected_settings
                    and isinstance(r.get("returned"), dict)
                    and r["returned"].get("class") == expected_receivers[stage]["provider_class"]
                    for r in llm_rows
                ):
                    raise ValueError("actual_assistant_constructor_binding_missing")
            elif stage == "tts":
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
            else:
                if (begin.get("operation_id") != finish.get("operation_id")
                        or begin.get("attempt_id") != finish.get("attempt_id")):
                    raise ValueError("stt_native_ids_mismatch")
                op, att = finish.get("operation_id"), finish.get("attempt_id")
                if not all(isinstance(v, str) and MAX_ID.fullmatch(v) for v in (op, att)):
                    raise ValueError("stt_native_ids_missing")
                records = [r for r in bindings if r.get("event") == "stt_constructor_return" and r.get("pid") == pid]
                if (len(records) != 1 or records[0].get("actualDevice") != "cpu"
                        or records[0].get("actualComputeType") != "int8_float32"
                        or records[0].get("returned", {}).get("class") != expected_receivers[stage]["provider_class"]
                        or records[0].get("actualArguments", {}).get("device") != "cpu"
                        or records[0].get("actualArguments", {}).get("compute_type") != "int8"
                        or str((Path(records[0].get("actualArguments", {}).get("model", "")) / "model.bin").resolve()) != paths["stt"]["model"]):
                    raise ValueError("actual_stt_constructor_binding_mismatch")
                record.update(operation_id=op, attempt_id=att)
            calls.append(record)
            seen_server.add((stage, server_id))
            pids[stage] = pid
    if (len(calls) != 45 or len(used_piper_starts) != 15 or len(used_piper_ends) != 15
            or sum(corr in selected_correlations for _, corr in routes) != 45
            or sum(corr in selected_correlations for _, corr in mesh_calls_by_key) != 45
            or any(len(rows) != 2 for rows in mesh_calls_by_key.values())):
        raise ValueError("remote_stage_denominator_mismatch")
    return {
        "schema": "aurora.distributed_k3_mesh_remote_stages_warmup.v1",
        "proof_generator_sha256": _sha(Path(__file__).read_bytes()),
        "candidate_manifest_sha256": candidate_sha, "cohort_manifest_sha256": cohort_sha,
        "receivers": expected_receivers, "warmup_qualification": warmup_qualification_receipt(qualification),
        "calls": calls,
        "native_id_semantics": {
            "assistant": "V430 resolved_chat_model.astream carries span_id; operation_id and attempt_id are null by source contract",
            "tts": "native operation_id and attempt_id required",
            "request_payload_sha256": "Gateway requester body only; not augmented LLM input hash",
        },
        "evidence_sha256": {"stages": _sha(span_bytes), "bindings": _sha(binding_bytes),
                            "mesh_calls": _sha(mesh_call_bytes), "route_runtime_pins": _sha(route_runtime_bytes)},
        "mesh_route_observation_gate": {
            "status": "passed", "route_rows": selected_route_count, "retained_route_rows": len(route_rows), "mesh_call_rows": selected_mesh_call_count, "retained_mesh_call_rows": len(mesh_calls),
            "route_observations_sha256": _sha(route_bytes),
            "route_sink_status_sha256": _sha(route_status_bytes),
            "continuous_route_stability_claimed": False,
            "snapshot_scope": "before_after_snapshots_all_pc_transports_no_pair_id_no_continuous_stability",
        },
    }

def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    for name in ("attempts-dir", "receiver-stages", "provider-bindings", "assistant-identity", "tts-identity", "stt-identity", "mesh-calls", "route-observations", "route-sink-status", "route-runtime-pins", "frozen-manifest", "output"):
        p.add_argument("--" + name, type=Path, required=True)
    p.add_argument("--candidate-manifest-sha256", required=True)
    p.add_argument("--cohort-manifest-sha256", required=True)
    p.add_argument("--expected-receivers", type=Path, required=True)
    a = p.parse_args()
    expected = json.loads(_read(a.expected_receivers, 64 * 1024))
    proof = build_proof(attempts_dir=a.attempts_dir, stage_path=a.receiver_stages,
        bindings_path=a.provider_bindings, assistant_identity_path=a.assistant_identity,
        tts_identity_path=a.tts_identity, stt_identity_path=a.stt_identity, mesh_calls_path=a.mesh_calls,
        route_observations_path=a.route_observations, route_sink_status_path=a.route_sink_status,
        route_runtime_pins_path=a.route_runtime_pins, frozen_manifest_path=a.frozen_manifest,
        candidate_sha=a.candidate_manifest_sha256,
        cohort_sha=a.cohort_manifest_sha256, expected_receivers=expected)
    if a.output.is_symlink() or a.output.exists():
        raise SystemExit("proof_output_exists_or_symlinked")
    data = (json.dumps(proof, sort_keys=True, separators=(",", ":")) + "\n").encode()
    fd = os.open(a.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data); stream.flush(); os.fsync(stream.fileno())
    print(json.dumps({"status": "receiver_proof_written", "calls": 45, "sha256": _sha(data)}))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
