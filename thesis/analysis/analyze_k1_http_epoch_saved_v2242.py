"""Analyse one sealed K1 HTTP epoch from saved files; never call the SUT."""

import argparse
import collections
import hashlib
import io
import json
import os
import runpy
import shutil
import sys
import wave
from datetime import datetime, timezone
from pathlib import Path

from k1_saved_case_history import distribution, paired_spans, phase_counts

ROOT = Path(__file__).resolve().parents[2]
RESOURCE_SOURCE = ROOT / "thesis/harness/analyze_k2_mesh_saved_v1904.py"
RESOURCES = runpy.run_path(str(RESOURCE_SOURCE))
HANDLERS = {
    "stt": ("requester", "stt.model_invoke"),
    "assistant": ("requester", "resolved_chat_model.astream"),
    "tts": ("provider", "tts.model_invoke"),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--requester-custody", type=Path, required=True)
    parser.add_argument("--requester-snapshot", type=Path, required=True)
    parser.add_argument("--requester-pid", type=int, required=True)
    parser.add_argument("--requester-start-ticks", type=int, required=True)
    parser.add_argument("--manifest-sha256", required=True)
    parser.add_argument("--provider-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    base, provider, out = (
        p.resolve() for p in [args.requester_custody, args.provider_dir, args.output_dir]
    )
    assert all(p.is_relative_to(ROOT / "thesis") for p in [base, provider, out])
    assert not out.exists() and shutil.disk_usage(ROOT).free > 2 * 1024**3 + 8 * 1024**2
    sources = []

    def digest(raw):
        return hashlib.sha256(raw).hexdigest()

    def read(path):
        path = path.resolve(strict=True)
        assert path.is_relative_to(ROOT / "thesis") and path.is_file()
        before = path.stat()
        raw = path.read_bytes()
        after = path.stat()
        assert (before.st_size, before.st_mtime_ns) == (after.st_size, after.st_mtime_ns)
        sources.append(
            {"path": str(path.relative_to(ROOT)), "bytes": len(raw), "sha256": digest(raw)}
        )
        return raw

    snapshot_raw = read(args.requester_snapshot)
    state = json.loads(snapshot_raw)
    frozen_raw = read(base / "frozen/condition.json")
    assert digest(frozen_raw) == args.manifest_sha256
    manifest = json.loads(frozen_raw)
    assert manifest["remoteTtsAuthBinding"] in [
        "existing_gateway_api_key",
        "existing_authorized_peer_bearer",
    ]

    def prefixes(name):
        position = 0
        for relative in state["prefixes"][name]["chunks"]:
            path = ROOT / relative
            key = str(path.relative_to(base))
            record = state["files"][key]
            raw = read(path)
            assert digest(raw) == record["sha256"] and len(raw) == record["bytes"]
            assert record["startByte"] == position and record["endByte"] == position + len(raw)
            position += len(raw)
            for line in raw.splitlines():
                if line.strip():
                    yield json.loads(line)
        assert position == state["prefixes"][name]["endByte"]

    control_record = state["snapshots"]["control-launch.json"]
    control_raw = read(ROOT / control_record["destination"])
    assert digest(control_raw) == control_record["sha256"]
    control = json.loads(control_raw)
    assert control["child_pid"] == args.requester_pid and control.get("exit_code") is not None
    assert not Path("/proc", str(args.requester_pid)).exists(), "No analysis on the live requester"
    summary_record = state["snapshots"]["summary.json"]
    summary_raw = read(ROOT / summary_record["destination"])
    assert digest(summary_raw) == summary_record["sha256"]
    terminal = json.loads(summary_raw)
    assert terminal["shutdown_completed"] is True
    rows = []
    for record in state["completedCases"].values():
        raw = read(ROOT / record["case"])
        assert digest(raw) == record["caseSha256"]
        values = [json.loads(line) for line in raw.splitlines() if line.strip()]
        assert len(values) == 1
        rows.append(values[0])
    rows.sort(key=lambda row: row["ordinal"])
    assert len({row["harness_case_id"] for row in rows}) == len(rows)
    assert len({row["correlation"]["correlation_id"] for row in rows}) == len(rows)
    assert all(
        row["candidate_manifest_sha256"] == manifest["candidateManifestSha256"] for row in rows
    )
    measured = [row for row in rows if row["phase"] == "measured"]
    warmups = [row for row in rows if row["phase"] == "warmup"]
    assert terminal["measured_requests"] == len(measured)
    first_index = manifest["epochLineage"]["firstConditionMeasuredIndex"]
    assert [row["condition_measured_index"] for row in measured] == list(
        range(first_index, first_index + len(measured))
    )

    identity = json.loads(read(provider / "receiver-identity.json"))
    assert identity["provider"] == manifest["remoteTtsReceiver"]
    assert identity["receiver_pid"] == manifest["providerReceiver"]["pid"]
    assert identity["manifest_sha256"] == manifest["providerManifestSha256"]
    provider_pid = identity["receiver_pid"]
    for kind, key in [("model", "model_sha256"), ("config", "config_sha256")]:
        assert (
            identity["actual_provider_files"][kind]["sha256"] == manifest["remoteTtsReceiver"][key]
        )
    remote_raw = read(provider / "voice-stages.jsonl")
    local, local_counts = paired_spans(
        prefixes("voice-stages.jsonl"), args.requester_pid, "requester"
    )
    remote, remote_counts = paired_spans(
        (json.loads(line) for line in remote_raw.splitlines() if line.strip()),
        provider_pid,
        "provider",
    )
    bindings = [
        json.loads(line)
        for line in read(provider / "actual-provider-bindings.jsonl").splitlines()
        if line.strip()
    ]

    worker_samples, worker_info = RESOURCES["resource_samples"](
        prefixes("resources.jsonl"), args.requester_pid, args.requester_start_ticks
    )
    resource_data = {"requester": (worker_samples, [x["ns"] for x in worker_samples])}
    resource_info = {"requester": worker_info, "provider": None}
    provider_resource_path = provider / "resources.jsonl"
    if measured:
        assert provider_resource_path.is_file(), (
            "Measured analysis requires actual retained provider resources"
        )
    if provider_resource_path.is_file():
        raw = read(provider_resource_path)
        samples, info = RESOURCES["resource_samples"](
            (json.loads(line) for line in raw.splitlines() if line.strip()),
            provider_pid,
            manifest["providerReceiver"]["startTicks"],
        )
        resource_data["provider"] = (samples, [x["ns"] for x in samples])
        resource_info["provider"] = info

    def resource_window(host, begin, end):
        if host not in resource_data:
            return {"status": "not_in_selected_saved_inputs", "metrics": None}
        samples, times = resource_data[host]
        try:
            value = RESOURCES["resource_window"](samples, times, begin, end)
        except AssertionError:
            return {"status": "same_host_bracket_unavailable", "metrics": None}
        interior = [x for x in samples if begin <= x["ns"] <= end]
        value["samplesInsideActualWindow"] = len(interior)
        value["sampledMaxRssKiB"] = max(
            (
                x["status"]["VmRSS"]
                for x in interior
                if isinstance(x["status"].get("VmRSS"), (int, float))
            ),
            default=None,
        )
        return {"status": "observed_bracket", "metrics": value}

    history, native_rows, gaps = [], [], []
    for row in rows:
        case_id = row["harness_case_id"]
        corr = row["correlation"]
        positive = row["status"] == "completed_correct"
        server = row.get("stages", {}).get("tts", {}).get("server_correlation_id")
        item = {
            "caseId": case_id,
            "phase": row["phase"],
            "conditionIndex": row.get("condition_measured_index"),
            "status": row["status"],
            "failure": row.get("failure"),
            "timeout": row.get("timeout"),
            "correctness": row.get("correctness"),
            "flowDurationMs": row["flow_duration_ms"],
            "requesterStages": row["stages"],
            "nativeStages": {},
            "outputAudio": row.get("output_audio"),
            "fullAttemptResources": resource_window(
                "requester", row["flow_started_monotonic_ns"], row["flow_ended_monotonic_ns"]
            ),
        }
        for stage, (host, handler) in HANDLERS.items():
            correlation = corr["correlation_id"] if host == "requester" else server
            group = local if host == "requester" else remote
            matches = [x for x in group.get(correlation, []) if x["handler"] == handler]
            if positive and len(matches) != 1:
                gaps.append(
                    {"caseId": case_id, "stage": stage, "completedNativeSpans": len(matches)}
                )
            item["nativeStages"][stage] = []
            for span in matches:
                if host == "requester":
                    for key, expected in [
                        ("requestId", corr["request_id"]),
                        ("sessionId", corr["session_id"]),
                    ]:
                        if span[key] is not None:
                            assert span[key] == expected
                begin, end = int(span["startMonotonicNs"]), int(span["endMonotonicNs"])
                entry = {
                    "caseId": case_id,
                    "phase": row["phase"],
                    "caseStatus": row["status"],
                    **span,
                    "nativeStage": span["stage"],
                    "stage": stage,
                    "resources": resource_window(host, begin, end),
                }
                if stage == "tts":
                    starts = [
                        x
                        for x in bindings
                        if x.get("event") == "piper_cli_call_start"
                        and x.get("pid") == provider_pid
                        and begin <= int(x["monotonicNs"]) <= end
                    ]
                    ends = [
                        x
                        for x in bindings
                        if x.get("event") == "piper_cli_call_return"
                        and x.get("pid") == provider_pid
                        and begin <= int(x["monotonicNs"]) <= end
                    ]
                    assert len(starts) == len(ends) == 1
                    assert starts[0]["actualArguments"]["useCuda"] is False
                    assert ends[0]["audioBytes"] > 0 and ends[0]["sampleRate"] == 22050
                    for kind, key in [("model", "model_file"), ("config", "config_file")]:
                        assert (
                            starts[0]["actualArguments"]["voice"][key]
                            == identity["actual_provider_files"][kind]["canonical_path"]
                        )
                item["nativeStages"][stage].append(entry)
                native_rows.append(entry)
        audio = row.get("output_audio")
        if positive:
            assert audio and row["correctness"]["all_expected"] is True
        if audio:
            path = base / audio["file"]
            raw = read(path)
            assert digest(raw) == audio["sha256"]
            with wave.open(io.BytesIO(raw), "rb") as wav:
                assert wav.getnframes() > 0 and wav.getsampwidth() == 2
        history.append(item)

    measured_native = [x for x in native_rows if x["phase"] == "measured"]
    correct = [row for row in measured if row["status"] == "completed_correct"]
    result = {
        "at": datetime.now(timezone.utc).isoformat(),
        "analysisPythonVersion": sys.version,
        "analysisExecutable": sys.executable,
        "scope": "One saved K1HTTP epoch, no cross-epoch pooling",
        "status": (
            "SAVED_NATIVE_GAPS_REQUIRE_REVIEW"
            if gaps
            else "SAVED_EPOCH_ANALYSIS_COMPLETE"
            if measured
            else "SAVED_WARMUP_ONLY_ANALYSIS_COMPLETE"
        ),
        "terminalStatus": terminal["status"],
        "terminalStopReason": terminal.get("stop_reason"),
        "cohort": manifest["cohortId"],
        "manifestSha256": args.manifest_sha256,
        "epochLineage": manifest["epochLineage"],
        "measured": phase_counts(measured),
        "timeoutFieldAbsent": sum("timeout" not in row for row in measured),
        "warmupsExcluded": phase_counts(warmups),
        "plannedEpochMeasured": manifest["epochLineage"]["plannedEpochMeasured"],
        "unattemptedEpoch": manifest["epochLineage"]["plannedEpochMeasured"] - len(measured),
        "correctOnlyLatencyMs": distribution([row["flow_duration_ms"] for row in correct]),
        "allAttemptsTimeToOutcomeMs": distribution([row["flow_duration_ms"] for row in measured]),
        "failedTimeToOutcomeMs": distribution(
            [row["flow_duration_ms"] for row in measured if row["status"] == "failed"]
        ),
        "nativeAllInvokedMeasuredMs": {
            stage: distribution([x["durationMs"] for x in measured_native if x["stage"] == stage])
            for stage in HANDLERS
        },
        "nativeCorrectFullAudioOnlyMs": {
            stage: distribution(
                [
                    x["durationMs"]
                    for x in measured_native
                    if x["stage"] == stage and x["caseStatus"] == "completed_correct"
                ]
            )
            for stage in HANDLERS
        },
        "nativeObservedStageCounts": dict(collections.Counter(x["stage"] for x in measured_native)),
        "allPhasesNativeStageJoins": len(native_rows),
        "positiveFlowNativeGaps": gaps,
        "pairingCounters": {"requester": local_counts, "provider": remote_counts},
        "resources": resource_info,
        "providerResourceDataPresent": provider_resource_path.is_file(),
        "quantileMethod": "Hyndman-Fan Type7; h=(n-1)*p with linear interpolation; ms",
        "resourcePolicy": "Same-host sample brackets with explicit slack; RSS uses actual-window samples. Missing observations stay unknown. Parent CPU excludes Piper child; host GPU/network counters are contextual, not exclusive request attribution.",
        "clockPolicy": "No cross-host timestamp subtraction; no sum or subtraction of independently computed percentiles",
        "routePolicy": manifest["transportClassification"],
        "newInference": 0,
        "newNetworkTraffic": 0,
    }
    out.mkdir(parents=True)
    (out / "REQUESTER-SNAPSHOT.json").write_bytes(snapshot_raw)
    for source in [
        Path(__file__),
        Path(__file__).with_name("k1_saved_case_history.py"),
        Path(__file__).with_name("native_span_metrics_v2.py"),
        RESOURCE_SOURCE,
    ]:
        raw = source.read_bytes()
        (out / (source.stem + "-AS-EXECUTED.py")).write_bytes(raw)
        sources.append(
            {"path": str(source.relative_to(ROOT)), "bytes": len(raw), "sha256": digest(raw)}
        )
    for name, value in [("SUMMARY.json", result), ("INPUTS.json", sources)]:
        (out / name).write_text(json.dumps(value, indent=2) + "\n")
    for name, values in [("CASE-HISTORY.jsonl", history), ("NATIVE-STAGES.jsonl", native_rows)]:
        with (out / name).open("x") as stream:
            for value in values:
                stream.write(json.dumps(value) + "\n")
    lines = [
        "# K1 HTTP saved epoch results",
        "",
        f"Cohort: `{result['cohort']}`; frozen SHA256 `{args.manifest_sha256}`.",
        "",
        f"Measured attempts: {len(measured)}; correct audio: {len(correct)}; "
        f"failed/interrupted: {result['measured']['failedOrInterrupted']}; "
        f"timeout flags: {result['measured']['timeouts']}. "
        f"Excluded warmups: {len(warmups)}. "
        f"Unattempted in this planned epoch: {result['unattemptedEpoch']}.",
        "",
        f"Terminal status: `{terminal['status']}`; stop reason: `{terminal.get('stop_reason')}`. "
        "No other epoch is pooled into these latency distributions.",
        "",
        "| Measured population | n | p50 ms | p90 ms | p95 ms |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    metrics = {
        "Correct full audio": result["correctOnlyLatencyMs"],
        "All attempts, time to outcome": result["allAttemptsTimeToOutcomeMs"],
        "Failures, time to outcome": result["failedTimeToOutcomeMs"],
        **{
            f"Native {stage}, all invoked": value
            for stage, value in result["nativeAllInvokedMeasuredMs"].items()
        },
    }
    for label, metric in metrics.items():
        lines.append(
            "| "
            + " | ".join(
                str(value) if value is not None else "unknown"
                for value in [
                    label,
                    metric["denominator"],
                    metric["p50_ms"],
                    metric["p90_ms"],
                    metric["p95_ms"],
                ]
            )
            + " |"
        )
    lines += [
        "",
        result["quantileMethod"] + ".",
        "",
        f"Actual native joins including warmups: {len(native_rows)}; "
        f"positive-flow native gaps: {len(gaps)}. "
        f"Provider resource data present: {provider_resource_path.is_file()}.",
        "",
        result["resourcePolicy"],
        "",
        result["clockPolicy"],
        "",
        "CASE-HISTORY.jsonl retains every selected case and its recorded failures, "
        "NATIVE-STAGES.jsonl retains the correlated stages/resources, and INPUTS.json "
        "pins actual source inputs. This analysis performs zero inference or network calls. "
        "A warmup-only report has zero measured observations and unknown measured quantiles; "
        "it does not establish completion of the planned condition.",
        "",
    ]
    (out / "REPORT.md").write_text("\n".join(lines))
    print(
        json.dumps(
            {
                "output": str(out.relative_to(ROOT)),
                "measured": len(measured),
                "excludedWarmups": len(warmups),
                "nativeJoinsAllPhases": len(native_rows),
                "positiveNativeGaps": len(gaps),
                "newInference": 0,
                "newNetworkTraffic": 0,
            }
        )
    )


if __name__ == "__main__":
    os.umask(0o077)
    main()
