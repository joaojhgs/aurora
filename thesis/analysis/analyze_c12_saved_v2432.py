#!/usr/bin/env python3
"""Reproduce descriptive C12 statistics from one bounded saved-data snapshot.

No model imports, inference, network calls, device actions or source changes.
Epochs and HTTP/local populations stay separate. Warmups are never pooled.
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import shutil
import tarfile


STAGES = {
    "stt": "stt.model_invoke",
    "assistant": "resolved_chat_model.astream",
    "tts": "tts.model_invoke",
}
TOPICS = {"stt": "Transcription.Transcribe", "tts": "TTS.Synthesize"}


def sha_bytes(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(path):
    raw = Path(path).read_bytes()
    return json.loads(raw), {"path": str(path), "bytes": len(raw), "sha256": sha_bytes(raw)}


def stats(values):
    xs = sorted(float(x) for x in values if x is not None)

    def quantile(p):
        if not xs:
            return None
        h = (len(xs) - 1) * p
        i = math.floor(h)
        j = math.ceil(h)
        return xs[i] + (h - i) * (xs[j] - xs[i])

    return {
        "n": len(xs),
        "units": "ms",
        "estimator": "Hyndman-Fan type7 h=(n-1)p linear interpolation",
        "p50": quantile(0.5),
        "p90": quantile(0.9),
        "p95": quantile(0.95),
        "min": None if not xs else xs[0],
        "max": None if not xs else xs[-1],
    }


def rates(rows):
    if len(rows) < 2:
        return {"n": len(rows), "offeredPerSecond": None, "completedPerSecond": None}
    starts = [int(x["start_monotonic_ns"]) for x in rows]
    ends = [int(x["end_monotonic_ns"]) for x in rows]
    start_window = (max(starts) - min(starts)) / 1e9
    end_window = (max(ends) - min(ends)) / 1e9
    return {
        "n": len(rows),
        "offeredPerSecond": None if start_window <= 0 else (len(rows) - 1) / start_window,
        "completedPerSecond": None if end_window <= 0 else (len(rows) - 1) / end_window,
        "scope": "Same-stream inter-arrival/inter-completion windows include between-pair copy/control gaps; excludes warmups and no capacity/saturation claim",
    }


def resource_summary(rows):
    peak_rss = 0
    peak_threads = 0
    gpu = {}
    net = {}
    errors = Counter()
    for row in rows:
        ctx = row.get("resource_context", {})
        status = ctx.get("child_status") or {}
        peak_rss = max(peak_rss, status.get("VmRSS") or 0)
        peak_threads = max(peak_threads, status.get("Threads") or 0)
        for d in ctx.get("amd_drm_devices") or []:
            key = str(d.get("device"))
            g = gpu.setdefault(key, {"peakBusyPercent": 0, "peakVramBytes": 0})
            g["peakBusyPercent"] = max(g["peakBusyPercent"], d.get("gpu_busy_percent") or 0)
            g["peakVramBytes"] = max(g["peakVramBytes"], d.get("mem_info_vram_used") or 0)
        interfaces = (ctx.get("host_network") or {}).get("interfaces", {})
        for name, counters in interfaces.items():
            if name not in net:
                net[name] = {"first": counters, "last": counters}
            net[name]["last"] = counters
        for error in ctx.get("counter_errors") or []:
            errors[(error.get("field"), error.get("errorClass"))] += 1
    for data in net.values():
        data["delta"] = {k: data["last"].get(k, 0) - v for k, v in data["first"].items()}
    return {
        "samples": len(rows),
        "peakProcessRssKiB": peak_rss,
        "peakProcessThreads": peak_threads,
        "gpuDevicePeaks": gpu,
        "aggregateInterfaceCounters": net,
        "counterErrorDenominators": [
            {"field": k[0], "errorClass": k[1], "samples": v} for k, v in errors.items()
        ],
        "scope": "Process RSS values from /proc/status are KiB; network interface deltas are host aggregates, not attributed to individual requests. Resource snapshot windows may include setup/warmups/control.",
    }


def analyze(campaign, output, snapshot_path=None):
    campaign = Path(campaign).resolve()
    output = Path(output).resolve()
    assert not output.exists()
    manifest, manifest_input = json_bytes(campaign / "CAMPAIGN-MANIFEST.json")
    observed_snapshot_path = (
        Path(snapshot_path) if snapshot_path is not None else campaign / "CURRENT.json"
    )
    snapshot_raw = observed_snapshot_path.read_bytes()
    snapshot = json.loads(snapshot_raw)
    snapshot_input = {
        "path": str(observed_snapshot_path),
        "bytes": len(snapshot_raw),
        "sha256": sha_bytes(snapshot_raw),
        "physicalAnalysisCopy": "CURRENT.snapshot.json",
    }
    cutoff = snapshot["lastOrdinal"]
    native = []
    queue = []
    resources = []
    histories = []
    inputs = [manifest_input, snapshot_input]
    populations = {"HTTP": [], "local": []}
    gaps = []
    last_offsets = {}
    copy_ms = []
    for ordinal in range(1, cutoff + 1):
        primary, primary_input = json_bytes(
            campaign / "requester/cases" / f"{ordinal:04d}" / "CASE.json"
        )
        custody, custody_input = json_bytes(
            campaign / "provider-custody" / f"{ordinal:04d}" / "CUSTODY.json"
        )
        receipt = custody["receipt"]
        archive = Path(custody["archive"])
        raw = archive.read_bytes()
        assert len(raw) == receipt["bytes"] and sha_bytes(raw) == receipt["sha256"]
        inputs.extend(
            [
                primary_input,
                custody_input,
                {"path": str(archive), "bytes": len(raw), "sha256": receipt["sha256"]},
            ]
        )
        local = receipt["localCase"]
        copy_ms.append(custody["copyDurationMs"])
        for name, offset in receipt["offsets"].items():
            assert offset["begin"] == last_offsets.get(name, 0)
            last_offsets[name] = offset["end"]
        with tarfile.open(archive) as tar:
            for member in tar.getmembers():
                assert member.isfile() and member.name in receipt["members"]
                data = tar.extractfile(member).read()
                expected = receipt["members"][member.name]
                assert len(data) == expected["bytes"] and sha_bytes(data) == expected["sha256"]
                if member.name == "local/CASE.json":
                    assert json.loads(data) == local
                target = {
                    "raw/voice-stages.jsonl": native,
                    "raw/bus-queue-observations.jsonl": queue,
                    "raw/resources.jsonl": resources,
                }.get(member.name)
                if target is not None:
                    target.extend(json.loads(line) for line in data.splitlines() if line)
        assert primary["ordinal"] == local["ordinal"] == ordinal
        assert local["parent_remote_stt_correlation_id"] == primary.get("case", {}).get(
            "stages", {}
        ).get("stt", {}).get("server_correlation_id")
        for stream, row in [("HTTP", primary), ("local", local)]:
            assert row["manifest_sha256"] == manifest_input["sha256"]
            populations[stream].append(row)
            histories.append(
                {
                    "stream": stream,
                    "ordinal": ordinal,
                    "phase": row["phase"],
                    "phaseIndex": row["phase_index"],
                    "status": row["status"],
                    "failure": row.get("failure"),
                    "timeout": row.get("timeout", False),
                    "correlationId": row["correlation_id"],
                    "caseDurationMs": row["duration_ms"],
                    "pipelineDurationMs": (row.get("case") or {}).get("flow_duration_ms"),
                    "sourceCase": primary_input["path"]
                    if stream == "HTTP"
                    else str(archive) + "#local/CASE.json",
                    "providerCapsuleSha256": receipt["sha256"],
                }
            )
    pairs = defaultdict(dict)
    for row in native:
        if row.get("event") in ["span_start", "span_end"]:
            pairs[(row.get("correlation_id"), row.get("handler"))][row["event"]] = row
    enqueues = defaultdict(list)
    for row in queue:
        enqueues[(row.get("correlation_id"), row.get("topic"))].append(row)
    summaries = {}
    stage_history = []
    for stream, rows in populations.items():
        measured = [r for r in rows if r["phase"] == "measured"]
        correct = [r for r in measured if r["status"] == "completed_correct"]
        failures = Counter(
            (r.get("failure") or {}).get("category", r["status"])
            for r in measured
            if r["status"] != "completed_correct"
        )
        stage_metrics = {}
        for stage, handler in STAGES.items():
            caller = []
            model = []
            enqueue_native = []
            queue_depths = []
            for row in measured:
                record = (row.get("case") or {}).get("stages", {}).get(stage, {})
                correlation = (
                    row["correlation_id"]
                    if stream == "local"
                    else record.get("server_correlation_id")
                )
                pair = pairs.get((correlation, handler), {})
                if record.get("status") == "completed":
                    caller.append(record.get("duration_ms"))
                if "span_start" not in pair or "span_end" not in pair:
                    if row["status"] == "completed_correct":
                        gaps.append(
                            {
                                "stream": stream,
                                "ordinal": row["ordinal"],
                                "stage": stage,
                                "reason": "positiveFlowNativeSpanMissing",
                            }
                        )
                    continue
                begin = int(pair["span_start"]["monotonic_ns"])
                end = int(pair["span_end"]["monotonic_ns"])
                assert end >= begin
                duration = (end - begin) / 1e6
                model.append(duration)
                topic = TOPICS.get(
                    stage,
                    "Orchestrator.UserInput"
                    if stream == "local"
                    else "Orchestrator.ExternalUserInput",
                )
                observations = enqueues.get((correlation, topic), [])
                e = observations[0] if len(observations) == 1 else None
                delay = None
                if e:
                    delay = {
                        "lowerMs": (begin - int(e["after_enqueue_monotonic_ns"])) / 1e6,
                        "upperMs": (begin - int(e["before_publish_monotonic_ns"])) / 1e6,
                        "interpretation": "Includes queue, dispatch and any pre-model work; assistant also includes graph/history/model setup. Not a pure queue duration.",
                    }
                    enqueue_native.append(delay["upperMs"])
                    queue_depths.append(e["queue_depth_after_enqueue"])
                elif row["status"] == "completed_correct":
                    gaps.append(
                        {
                            "stream": stream,
                            "ordinal": row["ordinal"],
                            "stage": stage,
                            "reason": "enqueueObservationMissingOrNonUnique",
                        }
                    )
                stage_history.append(
                    {
                        "stream": stream,
                        "ordinal": row["ordinal"],
                        "stage": stage,
                        "correlationId": correlation,
                        "nativeDurationMs": duration,
                        "enqueueToModelBounds": delay,
                        "handler": handler,
                        "nativeReceiverPid": pair["span_start"]["receiver_pid"],
                    }
                )
            stage_metrics[stage] = {
                "callerStageDuration": stats(caller),
                "nativeModelDurationInvokedPopulation": stats(model),
                "enqueueToModelUpperBoundMs": stats(enqueue_native),
                "observedQueueDepthAfterEnqueue": {
                    "n": len(queue_depths),
                    "max": max(queue_depths) if queue_depths else None,
                },
                "scope": "Caller durations use caller clock, native/queue measurements use provider clock; absolute timestamps are never subtracted across hosts.",
            }
        summaries[stream] = {
            "plannedMeasured": 900,
            "snapshotMeasuredOutcomes": len(measured),
            "correct": len(correct),
            "failedIncludingIncorrect": len(measured) - len(correct),
            "failureClasses": dict(failures),
            "timeoutsIncludedInFailed": sum(bool(r.get("timeout")) for r in measured),
            "excludedCurrentEpochWarmups": sum(r["phase"] == "warmup" for r in rows),
            "priorAcceptedExcludedWarmupPairs": manifest.get("priorAcceptedWarmupPairs", 0),
            "unobservedAtSnapshot": 900 - len(measured),
            "unobservedMeaning": "Not a completed measurement at this paired custody cutoff; later/in-flight data not claimed missing or unstarted.",
            "fullCaseCorrectOnly": stats([r["duration_ms"] for r in correct]),
            "pipelineCorrectOnly": stats(
                [(r.get("case") or {}).get("flow_duration_ms") for r in correct]
            ),
            "failedTimeToOutcome": stats(
                [r["duration_ms"] for r in measured if r["status"] != "completed_correct"]
            ),
            "rateIncludingBetweenPairGaps": rates(measured),
            "stages": stage_metrics,
        }
    output.mkdir(parents=True)
    terminal = (campaign / "REQUESTER-TERMINAL.json").exists()
    result = {
        "at": datetime.now(timezone.utc).isoformat(),
        "sourceScriptSha256": sha_bytes(Path(__file__).read_bytes()),
        "status": "SAVED_COMPLETE_PAIRED_TARGET"
        if all(v["snapshotMeasuredOutcomes"] == 900 for v in summaries.values())
        else "POINT_IN_TIME_PARTIAL_NOT900_COMPLETE",
        "campaignManifestSha256": manifest_input["sha256"],
        "sourceEpoch": campaign.name,
        "snapshotCurrentAt": snapshot["at"],
        "lastPairedOrdinal": cutoff,
        "requesterTerminalPresent": terminal,
        "populations": summaries,
        "positiveFlowEvidenceGaps": gaps,
        "providerResourceWindow": resource_summary(resources),
        "copyControlGapDuration": stats(copy_ms),
        "percentilesPooledAcrossStreamsOrEpochs": False,
        "warmupsPooledIntoMeasured": False,
        "newInference": 0,
        "newNetworkTraffic": 0,
        "historicalWarmups": "Original15 have separate verified accuracy/native/GPU receipt; their missing queue observations are not invented or pooled into current measured data.",
        "latencyBoundary": "Full-case duration includes fixed input read/start-record persistence, actual STT/LLM/TTS, strict correctness/valid-audio validation and WAV persistence; pipeline duration is separately retained from composition. Copy/control after completion is separate and influences reported inter-arrival/rate windows.",
    }
    (output / "SUMMARY.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    (output / "INPUT-MANIFEST.json").write_text(json.dumps(inputs, indent=2, sort_keys=True) + "\n")
    (output / "CURRENT.snapshot.json").write_bytes(snapshot_raw)
    for name, records in [
        ("CASE-HISTORY.jsonl", histories),
        ("NATIVE-STAGES-QUEUE.jsonl", stage_history),
    ]:
        with (output / name).open("w") as f:
            for row in records:
                f.write(json.dumps(row, sort_keys=True) + "\n")
    shutil.copyfile(__file__, output / "ANALYZER-AS-EXECUTED.py")
    lines = [
        "# C12 saved-data snapshot",
        "",
        result["status"],
        "",
        f"Cutoff: {snapshot['at']}; {cutoff} complete paired capsules.",
        "",
        "| Stream | Measured outcomes /900 | Correct | Failed | Timeout flags | Correct-only p90 ms | p95 ms |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for stream, s in summaries.items():
        q = s["fullCaseCorrectOnly"]
        lines.append(
            f"| {stream} | {s['snapshotMeasuredOutcomes']} | {s['correct']} | {s['failedIncludingIncorrect']} | {s['timeoutsIncludedInFailed']} | {q['p90']} | {q['p95']} |"
        )
    lines += [
        "",
        "HF7 linear interpolation, milliseconds. Every percentile denominator is explicit in SUMMARY.json. Samples condition on correct full audio; failed/timeout outcomes remain in the attempt population. Stream/epoch/warmup distributions are separate. Partial small-sample quantiles are descriptive, not a final900 tail claim.",
        "",
        result["latencyBoundary"],
        "",
        "Provider queue/native comparisons share one provider monotonic clock. Enqueue-to-model bounds include dispatch and pre-model processing; no pure queue/network/protocol-overhead claim. Resource/network counters are aggregate, not per-request attribution.",
        "",
        f"Positive-flow native/queue gaps: {len(gaps)}. No new inference or network traffic was generated.",
    ]
    (output / "REPORT.md").write_text("\n".join(lines) + "\n")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--campaign", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--snapshot",
        type=Path,
        help="Reuse an exact saved CURRENT snapshot; default captures current completed paired cutoff",
    )
    args = parser.parse_args()
    r = analyze(args.campaign, args.output, args.snapshot)
    print(
        json.dumps(
            {
                "status": r["status"],
                "lastPairedOrdinal": r["lastPairedOrdinal"],
                "counts": {k: v["snapshotMeasuredOutcomes"] for k, v in r["populations"].items()},
                "positiveFlowEvidenceGaps": len(r["positiveFlowEvidenceGaps"]),
                "newInference": 0,
            }
        )
    )
