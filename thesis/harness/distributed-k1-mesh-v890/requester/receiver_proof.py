"""Offline exact-peer mesh TTS proof assembler; never starts a service."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import time
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


def _await_route_warmups(rows_path: Path, status_path: Path) -> tuple[bytes, list[dict[str, Any]], bytes, dict[str, Any]]:
    deadline = time.monotonic() + 20.0
    while time.monotonic() < deadline:
        try:
            status_bytes = _read_regular(status_path, 64 * 1024)
            status = json.loads(status_bytes)
            if (isinstance(status, dict) and status.get("state") == "accepting"
                    and status.get("complete") is False
                    and status.get("accepted_rows") == 15
                    and status.get("written_rows") == 15):
                rows_bytes = _read_regular(rows_path, 32 * 1024 * 1024)
                rows = _jsonl(rows_bytes)
                if len(rows) == 15:
                    return rows_bytes, rows, status_bytes, status
        except (OSError, ValueError, json.JSONDecodeError):
            pass
        time.sleep(0.1)
    raise ValueError("mesh_route_warmup_observations_not_flushed_within_bound")


def build_proof(*, attempts_dir: Path, stage_path: Path, bindings_path: Path,
                requester_calls_path: Path,
                route_observations_path: Path, route_sink_status_path: Path,
                route_runtime_pins_path: Path, cohort_manifest: dict[str, Any],
                cohort_sha: str,
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
    if identity.get("peer_id_sha256") != expected.get("peer_id_sha256"):
        raise ValueError("receiver_mesh_peer_identity_mismatch")
    spans = _jsonl(_read_regular(stage_path))
    bindings = _jsonl(_read_regular(bindings_path, 16 * 1024 * 1024))
    requester_calls = _jsonl(_read_regular(requester_calls_path, 16 * 1024 * 1024))
    route_observation_bytes, route_rows, route_sink_bytes, route_sink = _await_route_warmups(
        route_observations_path, route_sink_status_path)
    route_runtime_bytes = _read_regular(route_runtime_pins_path, 256 * 1024)
    route_runtime = json.loads(route_runtime_bytes)
    implementation = cohort_manifest.get("implementation", {})
    runtime_pin_source_bytes = _read_regular(Path(__file__).with_name("route_runtime_pins.json"), 64 * 1024)
    runtime_pin_source_sha = _sha(runtime_pin_source_bytes)
    if (cohort_manifest.get("candidateManifestSha256") != candidate_sha
            or runtime_pin_source_sha != implementation.get("routeRuntimePinsSha256")):
        raise ValueError("mesh_route_frozen_source_binding_mismatch")
    if (not isinstance(route_sink, dict)
            or route_sink.get("schema") != "aurora.mesh_route_observation_sink.v1"
            or route_sink.get("state") != "accepting"
            or route_sink.get("complete") is not False
            or route_sink.get("accepted_rows") != 15
            or route_sink.get("written_rows") != 15
            or route_sink.get("dropped_rows") != 0
            or route_sink.get("oversize_rows") != 0
            or route_sink.get("quota_rows") != 0
            or route_sink.get("invalid_rows") != 0
            or route_sink.get("writer_error_class") is not None):
        raise ValueError("mesh_route_sink_warmup_evidence_incomplete")
    if (not isinstance(route_runtime, dict)
            or route_runtime.get("schema") != "aurora.mesh_route_runtime_install.v1"
            or route_runtime.get("status") != "verified_before_observer_install"
            or route_runtime.get("frozen_manifest_sha256") != cohort_sha
            or route_runtime.get("route_observer_sha256") != implementation.get("routeObserverSha256")
            or route_runtime.get("route_sink_sha256") != implementation.get("routeSinkSha256")
            or route_runtime.get("runtime_pins_sha256") != implementation.get("routeRuntimePinsSha256")
            or route_runtime.get("observation_limit")
                != "before_after_snapshots_all_pc_transports_no_pair_id_no_continuous_stability"):
        raise ValueError("mesh_route_runtime_source_pin_incomplete")
    if len(route_rows) != 15:
        raise ValueError("mesh_route_observation_count_mismatch")
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
    mesh_starts = [row for row in requester_calls if row.get("event") == "mesh_peer_call_start"
                   and row.get("topic") == "TTS.Synthesize"]
    mesh_ends = [row for row in requester_calls if row.get("event") == "mesh_peer_call_end"
                 and row.get("topic") == "TTS.Synthesize"]
    if len(mesh_starts) != 15 or len(mesh_ends) != 15:
        raise ValueError("actual_exact_peer_mesh_call_count_mismatch")
    for row in starts:
        args = row.get("actualArguments", {})
        voice = args.get("voice", {}) if isinstance(args, dict) else {}
        if (args.get("useCuda") is not False or not isinstance(args.get("piperExecutable"), str)
                or voice.get("model_file") != admitted_paths["model"]
                or voice.get("config_file") != admitted_paths["config"]):
            raise ValueError("actual_piper_arguments_incomplete")
    calls: list[dict[str, Any]] = []
    routes_by_correlation: dict[str, dict[str, Any]] = {}
    route_requester_pid: int | None = None
    observed_path_classes = {"before": {"direct": 0, "relay": 0},
                             "after": {"direct": 0, "relay": 0}}
    for route_row in route_rows:
        corr = route_row.get("correlation_id")
        if (route_row.get("schema") != "aurora.mesh_route_observation.v1"
                or route_row.get("topic") != "TTS.Synthesize"
                or not isinstance(corr, str) or corr in routes_by_correlation
                or route_row.get("request_outcome") != "ok"
                or type(route_row.get("requester_pid")) is not int
                or route_row["requester_pid"] <= 0):
            raise ValueError("mesh_route_observation_row_invalid")
        if route_requester_pid is None:
            route_requester_pid = route_row["requester_pid"]
        if route_row["requester_pid"] != route_requester_pid:
            raise ValueError("mesh_route_observation_process_mismatch")
        routes_by_correlation[corr] = route_row
    used_starts: set[int] = set()
    used_ends: set[int] = set()
    seen_server: set[str] = set()
    for ordinal in range(1, 16):
        case_id = f"audio-campaign-v881-{ordinal:04d}"
        attempt_path = attempts_dir / f"attempt-{ordinal:04d}-warmup.jsonl"
        attempt_data = _read_regular(attempt_path, 2 * 1024 * 1024)
        attempt = json.loads(attempt_data)
        correlation = attempt.get("correlation", {}).get("correlation_id")
        stage = attempt.get("stages", {}).get("tts", {})
        mesh_correlation = stage.get("mesh_correlation_id")
        request_hash = stage.get("request_text_sha256")
        if (attempt.get("harness_case_id") != case_id or attempt.get("phase") != "warmup"
                or attempt.get("status") != "completed_correct"
                or attempt.get("correctness", {}).get("all_expected") is not True
                or not isinstance(correlation, str) or not MAX_ID.fullmatch(correlation)
                or mesh_correlation != correlation
                or not isinstance(request_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", request_hash)
                or correlation in seen_server):
            raise ValueError("requester_warmup_binding_incomplete")
        matching_route_start = [r for r in mesh_starts
                                if r.get("correlation_id") == mesh_correlation]
        matching_route_end = [r for r in mesh_ends
                              if r.get("correlation_id") == mesh_correlation]
        route_start = matching_route_start[0] if len(matching_route_start) == 1 else {}
        route_end = matching_route_end[0] if len(matching_route_end) == 1 else {}
        mesh_start_ns = _integer(route_start.get("monotonic_start_ns"))
        mesh_end_ns = _integer(route_end.get("monotonic_end_ns"))
        if (len(matching_route_start) != 1 or len(matching_route_end) != 1
                or route_start.get("peer_id_sha256") != expected.get("peer_id_sha256")
                or route_end.get("peer_id_sha256") != expected.get("peer_id_sha256")
                or mesh_start_ns is None or mesh_end_ns is None or mesh_end_ns <= mesh_start_ns
                or mesh_start_ns != _integer(route_end.get("monotonic_start_ns"))
                or route_end.get("outcome") != "ok"):
            raise ValueError("actual_exact_peer_mesh_route_not_confirmed")
        route_row = routes_by_correlation.get(mesh_correlation)
        if route_row is None:
            raise ValueError("mesh_route_observation_correlation_missing")
        observation_start_ns = _integer(route_row.get("request_monotonic_start_ns"))
        observation_end_ns = _integer(route_row.get("request_monotonic_end_ns"))
        before, after = route_row.get("before"), route_row.get("after")
        if (observation_start_ns is None or observation_end_ns is None
                or observation_end_ns <= observation_start_ns
                or route_row.get("requester_pid") != route_requester_pid
                or route_start.get("pid") != route_requester_pid
                or route_end.get("pid") != route_requester_pid
                or route_row.get("topic") != "TTS.Synthesize"
                or route_row.get("request_outcome") != "ok"
                or mesh_start_ns < observation_start_ns
                or mesh_end_ns > observation_end_ns
                or not isinstance(before, dict) or not isinstance(after, dict)):
            raise ValueError("mesh_route_observation_interval_invalid")
        peer_hash = expected.get("peer_id_sha256")
        session_hash = before.get("session_peer_id_sha256")
        connection_hash = before.get("peer_connection_instance_sha256")
        for snapshot in (before, after):
            sampled = _integer(snapshot.get("sampled_monotonic_ns"))
            if (snapshot.get("status") != "selected_nominated_pair_observed"
                    or snapshot.get("pid") != route_requester_pid
                    or snapshot.get("clock_domain") != f"python.monotonic_ns:pid:{route_requester_pid}"
                    or snapshot.get("peer_id_sha256") != peer_hash
                    or not isinstance(session_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", session_hash)
                    or snapshot.get("session_peer_id_sha256") != session_hash
                    or not isinstance(connection_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", connection_hash)
                    or snapshot.get("peer_connection_instance_sha256") != connection_hash
                    or sampled is None):
                raise ValueError("mesh_route_exact_peer_snapshot_invalid")
        before_sampled = _integer(before.get("sampled_monotonic_ns"))
        after_sampled = _integer(after.get("sampled_monotonic_ns"))
        if (before_sampled is None or after_sampled is None
                or before_sampled > observation_start_ns or after_sampled < observation_end_ns):
            raise ValueError("mesh_route_snapshot_clock_order_invalid")
        snapshot_classes: dict[str, list[str]] = {}
        for name, snapshot in (("before", before), ("after", after)):
            pairs = snapshot.get("selected_pairs")
            if not isinstance(pairs, list) or not pairs or len(pairs) > 32:
                raise ValueError("mesh_route_selected_pairs_invalid")
            classes: set[str] = set()
            for pair in pairs:
                if (not isinstance(pair, dict) or pair.get("nominated") is not True
                        or pair.get("pair_state") != "succeeded"
                        or pair.get("path_class") not in ("direct", "relay")
                        or pair.get("local_candidate_type") not in ("host", "srflx", "prflx", "relay")
                        or pair.get("remote_candidate_type") not in ("host", "srflx", "prflx", "relay")
                        or pair.get("local_protocol") not in ("udp", "tcp", "tcp-so")
                        or pair.get("remote_protocol") not in ("udp", "tcp", "tcp-so")):
                    raise ValueError("mesh_route_selected_pair_fields_invalid")
                classes.add(pair["path_class"])
            snapshot_classes[name] = sorted(classes)
            for classification in classes:
                observed_path_classes[name][classification] += 1
        route_summary = {
            "status": "selected_nominated_pair_observed_before_and_after",
            "correlation_id": mesh_correlation,
            "requester_pid": route_requester_pid,
            "peer_id_sha256": peer_hash,
            "session_peer_id_sha256": session_hash,
            "peer_connection_instance_sha256": connection_hash,
            "before_path_classes": snapshot_classes["before"],
            "after_path_classes": snapshot_classes["after"],
            "same_pair_identity_available": False,
            "continuous_route_stability_claimed": False,
        }
        group = span_groups.get(mesh_correlation, {})
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
            "mesh_correlation_id": mesh_correlation, "native_correlation_id": mesh_correlation,
            "selected_peer_id_sha256": expected["peer_id_sha256"],
            "request_text_sha256": request_hash, "handler": "tts.model_invoke",
            "outcome": "completed", "operation_id": operation_id,
            "attempt_id": attempt_id, "receiver_pid": identity["receiver_pid"],
            "provider": provider, "route_observation": route_summary,
        })
        seen_server.add(mesh_correlation)
    if len(used_starts) != 15 or len(used_ends) != 15:
        raise ValueError("receiver_provider_call_denominator_mismatch")
    return {
        "schema": "aurora.distributed_k1_mesh_tts_warmup.v1",
        "proof_generator_sha256": _sha(Path(__file__).read_bytes()),
        "candidate_manifest_sha256": candidate_sha,
        "receiver_pid": identity["receiver_pid"], "provider": provider,
        "actual_provider_file_sha256": {
            "model": actual_files["model"]["sha256"],
            "config": actual_files["config"]["sha256"],
        },
        "calls": calls,
        "route_observation_gate": {
            "schema": "aurora.mesh_route_warmup_gate.v1",
            "status": "passed",
            "observed_calls": len(route_rows),
            "joined_receiver_calls": len(calls),
            "requester_pid": route_requester_pid,
            "sink_written_rows": route_sink["written_rows"],
            "sink_dropped_rows": route_sink["dropped_rows"],
            "sink_oversize_rows": route_sink["oversize_rows"],
            "sink_quota_rows": route_sink["quota_rows"],
            "sink_invalid_rows": route_sink["invalid_rows"],
            "runtime_source_pin_status": route_runtime["status"],
            "frozen_manifest_sha256": cohort_sha,
            "route_observer_sha256": route_runtime["route_observer_sha256"],
            "route_sink_sha256": route_runtime["route_sink_sha256"],
            "route_runtime_pins_sha256": route_runtime["runtime_pins_sha256"],
            "continuous_route_stability_claimed": False,
            "snapshot_scope": "before_after_snapshots_all_pc_transports_no_pair_id_no_continuous_stability",
            "observed_path_class_rows": observed_path_classes,
        },
        "evidence_sha256": {
            "stage_rows": _sha(_read_regular(stage_path)),
            "provider_bindings": _sha(_read_regular(bindings_path, 16 * 1024 * 1024)),
            "requester_mesh_calls": _sha(_read_regular(requester_calls_path, 16 * 1024 * 1024)),
            "requester_route_observations": _sha(route_observation_bytes),
            "route_sink_status": _sha(route_sink_bytes),
            "route_runtime_pins": _sha(route_runtime_bytes),
            "route_runtime_pin_source": runtime_pin_source_sha,
            "receiver_identity": _sha(_read_regular(identity_path, 64 * 1024)),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--attempts-dir", type=Path, required=True)
    parser.add_argument("--receiver-stages", type=Path, required=True)
    parser.add_argument("--provider-bindings", type=Path, required=True)
    parser.add_argument("--requester-mesh-calls", type=Path, required=True)
    parser.add_argument("--requester-route-observations", type=Path, required=True)
    parser.add_argument("--route-sink-status", type=Path, required=True)
    parser.add_argument("--route-runtime-pins", type=Path, required=True)
    parser.add_argument("--frozen-manifest", type=Path, required=True)
    parser.add_argument("--frozen-manifest-sha256", required=True)
    parser.add_argument("--receiver-identity", type=Path, required=True)
    parser.add_argument("--candidate-manifest-sha256", required=True)
    parser.add_argument("--expected-provider-json", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    expected = json.loads(_read_regular(args.expected_provider_json, 64 * 1024))
    cohort_bytes = _read_regular(args.frozen_manifest, 256 * 1024)
    cohort_sha = _sha(cohort_bytes)
    if cohort_sha != args.frozen_manifest_sha256:
        raise SystemExit("frozen_manifest_hash_mismatch")
    cohort_manifest = json.loads(cohort_bytes)
    proof = build_proof(attempts_dir=args.attempts_dir, stage_path=args.receiver_stages,
                        bindings_path=args.provider_bindings,
                        requester_calls_path=args.requester_mesh_calls,
                        route_observations_path=args.requester_route_observations,
                        route_sink_status_path=args.route_sink_status,
                        route_runtime_pins_path=args.route_runtime_pins,
                        cohort_manifest=cohort_manifest, cohort_sha=cohort_sha,
                        identity_path=args.receiver_identity,
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
