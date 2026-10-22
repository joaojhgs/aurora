"""Recompute V1620 requester metrics from saved cases; never execute Aurora."""

import argparse
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from k1_saved_case_history import (
    distribution,
    phase_counts,
    read_bound,
    sha,
    write_bytes_once,
    write_once,
)

ROOT = Path(__file__).resolve().parents[2]
MANIFEST_SHA = "4f1a09e7ac7dedeaeae6c1bef5a364d4a007e9249aec74f20a0b63b6375a6279"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--custody", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    custody, output = args.custody.resolve(), args.output.resolve()
    assert custody.is_relative_to(ROOT / "thesis")
    assert output.is_relative_to(ROOT / "thesis") and not output.exists()
    sources = []
    snapshot = read_bound(custody / "CURRENT.json", sources)
    state = json.loads(snapshot)
    frozen = read_bound(custody / "condition-frozen.json", sources)
    assert sha(frozen) == MANIFEST_SHA
    manifest = json.loads(frozen)
    terminal = json.loads(read_bound(custody / "terminal-v1637/summary.json", sources))
    rows = []
    for record in state["completedCases"].values():
        raw = read_bound(ROOT / record["case"], sources)
        assert sha(raw) == record["caseSha256"]
        parsed = [json.loads(line) for line in raw.splitlines() if line.strip()]
        assert len(parsed) == 1
        row = parsed[0]
        assert row["frozen_cohort_manifest_sha256"] == MANIFEST_SHA
        assert row["status"] == record["status"]
        rows.append(row)
    rows.sort(key=lambda row: row["ordinal"])
    assert len({row["harness_case_id"] for row in rows}) == len(rows)
    assert len({row["correlation"]["correlation_id"] for row in rows}) == len(rows)
    measured = [row for row in rows if row["phase"] == "measured"]
    warmups = [row for row in rows if row["phase"] == "warmup"]
    assert [row["condition_measured_index"] for row in measured] == list(range(717, 741))
    assert len(warmups) == 15
    correct = [row for row in measured if row["status"] == "completed_correct"]
    quality = [row for row in measured if row.get("partial_quality_incorrect") is True]
    transport = [row for row in measured if row.get("failure", {}).get("code") == "transport_ambiguous"]
    assert (len(correct), len(quality), len(transport)) == (11, 12, 1)
    assert terminal["correct"] == len(correct)
    assert terminal["correctness_denominator"]["measured_attempted"] == len(measured)
    for name, percentile in [("p50", "p50_ms"), ("p90", "p90_ms"), ("p95", "p95_ms")]:
        actual = distribution([r["flow_duration_ms"] for r in correct])[percentile]
        assert abs(actual - terminal["completed_flow_latency_ms_r7_including_incorrect"][name]) < 1e-8
    elapsed = {
        "setupSeconds": terminal["setup_duration_ms"] / 1000,
        "conditionSeconds": terminal["condition_elapsed_ms_excluding_setup_and_shutdown"] / 1000,
        "shutdownSeconds": terminal["shutdown_duration_ms"] / 1000,
    }
    charge = sum(elapsed.values())
    budget = manifest["cumulativeConditionBudget"]
    history = [{
        "conditionMeasuredIndex": row.get("condition_measured_index"),
        "phase": row["phase"], "ordinal": row["ordinal"],
        "caseId": row["harness_case_id"], "correlation": row["correlation"],
        "status": row["status"], "timeout": row.get("timeout"),
        "correctness": row.get("correctness"), "failure": row.get("failure"),
        "flowDurationMs": row.get("flow_duration_ms"),
        "flowEndPoint": row.get("flow_end_point"),
        "stages": row.get("stages"), "outputAudio": row.get("output_audio"),
    } for row in rows]
    summary = {
        "schema": "aurora.k3.requester-terminal-analysis.v1",
        "at": datetime.now(timezone.utc).isoformat(), "status": "TERMINAL_PARTIAL_24_OF_96",
        "cohort": manifest["cohortId"], "frozenManifestSha256": MANIFEST_SHA,
        "analysisSourceSha256": sha(Path(__file__).read_bytes()),
        "sharedDistributionSourceSha256": sha(Path(__file__).with_name("k1_saved_case_history.py").read_bytes()),
        "quantileSourceSha256": sha(Path(__file__).with_name("native_span_metrics_v2.py").read_bytes()),
        "measured": {**phase_counts(measured), "partialQualityFailure": len(quality),
                     "transportFailure": len(transport), "timeoutFlagAbsent": sum("timeout" not in r for r in measured)},
        "excludedWarmups": phase_counts(warmups),
        "failureCodes": dict(Counter(r.get("failure", {}).get("code") for r in measured if r.get("failure"))),
        "flowMetricsMs": {
            "completedCorrect": distribution([r.get("flow_duration_ms") for r in correct]),
            "qualityFailureObservedPartial": distribution([r.get("flow_duration_ms") for r in quality]),
            "transportFailureObservedPartial": distribution([r.get("flow_duration_ms") for r in transport]),
            "allObservedAttemptsIncludingPartialFailures": distribution([r.get("flow_duration_ms") for r in measured]),
        },
        "requesterStageMetricsMs": {stage: {
            "completedClientCalls": distribution([r.get("stages", {}).get(stage, {}).get("duration_ms")
                for r in measured if r.get("stages", {}).get(stage, {}).get("status") == "completed"]),
            "allObservedCallsIncludingFailures": distribution([r.get("stages", {}).get(stage, {}).get("duration_ms") for r in measured]),
        } for stage in ["stt", "assistant", "tts"]},
        "conditionCountsOnly": {"target": 900, "priorAttempted": 716, "priorCorrect": 714,
            "priorFailed": 2, "combinedAttempted": 740, "combinedCorrect": 725,
            "combinedFailed": 15, "unattempted": 160, "nextUnattemptedIndex": 741},
        "budget": {**elapsed, "actualChargeSeconds": charge,
            "priorUsedSeconds": budget["priorUsedSeconds"],
            "cumulativeUsedSeconds": budget["priorUsedSeconds"] + charge,
            "capSeconds": budget["conditionCapSeconds"],
            "remainingSeconds": budget["conditionCapSeconds"] - budget["priorUsedSeconds"] - charge},
        "quantileMethod": "Hyndman-Fan Type 7: h=(n-1)*p; linear interpolation; milliseconds",
        "populationPolicy": "Warmups excluded. Failed partial durations are not successful end-to-end latency. No epoch percentile pooling. Eleven successes are a small conditional population, not a 900-request acceptance result.",
        "nativeMeasuredSpans": "UNKNOWN pending original Personal provider raw-prefix retrieval; the 45 warmup native joins prove admission only.",
        "resources": {"requesterRetainedBytes": state["prefixes"]["resources.jsonl"]["endByte"],
            "providerCurrentState": "UNKNOWN", "perStageResourceAttribution": "PENDING saved provider delta"},
        "replyQuality": "All12 retain strict one-word failures; exact hash identifies a factual full-sentence response, not raw server-body recovery or proven model/runtime cause.",
        "missingStagePolicy": "TTS was not reached for13 failures. Missing assistant response correlation on transport failure is not force-joined by wall time/order.",
        "newMeasurements": 0, "sutCalls": 0,
    }
    output.mkdir(parents=True)
    artifacts = [write_once(output / "SUMMARY.json", summary), write_once(output / "CASE-HISTORY.json", history),
        write_once(output / "SOURCE-IDENTITIES.json", sources),
        write_bytes_once(output / "REQUESTER-CURRENT.snapshot.json", snapshot)]
    write_once(output / "CUSTODY.json", {"outputs": artifacts, "newMeasurements": 0, "sutCalls": 0})
    print(json.dumps({"output": str(output), "measured": summary["measured"],
        "successfulCorrectMetricsMs": summary["flowMetricsMs"]["completedCorrect"], "budget": summary["budget"]}))


if __name__ == "__main__":
    main()
