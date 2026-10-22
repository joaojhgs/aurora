"""Index existing core-condition results; no inference, network or new quantiles."""

import argparse
import hashlib
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
C = "thesis/campaigns/"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--input-inventory", type=Path)
    args = parser.parse_args()
    out = args.output_dir.resolve()
    assert out.is_relative_to(ROOT / "thesis") and not out.exists()
    assert shutil.disk_usage(ROOT).free > 2 * 1024**3 + 1024**2
    sources = []
    saved_inputs = {}
    prior = json.loads(args.input_inventory.read_bytes()) if args.input_inventory else None
    pinned = {x["path"]: x for x in prior["sources"]} if prior else {}

    def load(relative):
        path = ROOT / pinned[relative]["physicalSnapshot"] if pinned else ROOT / relative
        assert path.resolve().is_relative_to(ROOT / "thesis")
        raw = path.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        if pinned:
            assert digest == pinned[relative]["sha256"]
        snapshot = out / "inputs" / (digest + ".json")
        saved_inputs[snapshot] = raw
        sources.append(
            {
                "path": relative,
                "bytes": len(raw),
                "sha256": digest,
                "physicalSnapshot": str(snapshot.relative_to(ROOT)),
            }
        )
        return json.loads(raw)

    rows = []

    def add(
        condition,
        route,
        remote_stages,
        attempted,
        correct,
        failed,
        timeouts,
        source,
        latency,
        warmups,
        policy,
    ):
        assert attempted == correct + failed and 0 <= timeouts <= failed
        assert attempted <= 900
        rows.append(
            {
                "condition": condition,
                "route": route,
                "remoteStages": remote_stages,
                "targetMeasured": 900,
                "measuredAttempted": attempted,
                "correctFullAudio": correct,
                "failedIncludingQualityAndTransport": failed,
                "timeoutsIncludedInFailed": timeouts,
                "unattempted": 900 - attempted,
                "excludedWarmups": warmups,
                "attemptTargetClosed": attempted == 900,
                "source": source,
                "retainedLatencyStatistics": latency,
                "latencyUnits": "ms",
                "latencyPolicy": policy,
                "statisticsProvenance": "Extracted from the named retained analysis; this index does not recompute historical raw quantiles",
            }
        )

    source = "thesis/evidence/orca-relayed-http-v1197/terminal-v1377/summary.json"
    v = load(source)
    den = v["correctness_denominator"]
    add(
        "K1 HTTP",
        "Orca-relayed HTTP",
        ["TTS"],
        den["measured_attempted"],
        den["measured_correct"],
        den["measured_failed_or_interrupted"],
        v["timeouts"],
        source,
        v["successful_correct_latency_ms_r7"],
        den["warmup_attempted_excluded"],
        "Original180 only; later source/auth/residency versions must remain separate",
    )

    base = C + "worker-desktop-k1-p2p-tts-remaining191-v2153/"
    source = base + "CONDITION-CLOSURE-v2201.json"
    v = load(source)
    analysis = load(base + "analysis-v2200/RESULT.json")
    add(
        "K1 P2P",
        "Actual paired P2P",
        ["TTS"],
        v["measuredAttempted"],
        v["correctFullAudio"],
        v["failed"],
        v["timeoutsIncludedInFailed"],
        source,
        {k: x["correctFullAudioOnly"] for k, x in analysis["perEpoch"].items()},
        v["excludedWarmupsInMeasuredEpochs"],
        analysis["latencyPolicy"],
    )

    base = C + "worker-desktop-k2-orca-relayed-http-v1264/terminal-v1465/"
    source = base + "FINAL-VALIDATION-v1472.json"
    v = load(source)
    analysis = load(base + "analysis-v1469/SUMMARY.json")
    den = v["measured"]
    add(
        "K2 HTTP",
        "Orca-relayed HTTP",
        ["TTS", "LLM"],
        den["attempted"],
        den["correct"],
        den["failedOrInterrupted"],
        den["timeouts"],
        source,
        analysis["flowMetricsMs"]["successfulCorrect"],
        v["excludedWarmups"],
        "Correct fullaudio only;103 strict answer failures remain in attempt denominator",
    )

    base = C + "worker-desktop-k2-p2p-assistant-tts-v1826/"
    source = base + "CONDITION-CLOSURE-v1906.json"
    v = load(source)
    analysis = load(base + "analysis-v1904/SUMMARY.json")
    add(
        "K2 P2P",
        "Actual paired P2P",
        ["TTS", "LLM"],
        v["measured"],
        v["correctFullAudio"],
        v["failed"],
        v["timeouts"],
        source,
        analysis["metrics"]["successfulCorrectE2E"],
        v["excludedWarmups"],
        "Correct fullaudio only; failure time-to-outcome and native invoked-stage populations are separate",
    )

    source = (
        C
        + "worker-desktop-k3-orca-relayed-http-remaining-v1682/condition-900-analysis/SUMMARY.json"
    )
    v = load(source)
    den = v["counts"]
    add(
        "K3 HTTP",
        "Orca-relayed HTTP",
        ["TTS", "LLM", "STT"],
        den["attempted"],
        den["correct"],
        den["failedOrInterrupted"],
        den["timeouts"],
        source,
        v["correctOnlyLatencyMs"],
        {"perEpoch": 15, "epochs": len(v["epochs"])},
        v["populationPolicy"],
    )

    base = C + "worker-desktop-k3-p2p-full-audio-v2043/"
    source = base + "CONDITION-CLOSURE-v2134.json"
    v = load(source)
    analysis = load(base + "analysis-v2130/RESULT.json")
    den = v["measured"]
    add(
        "K3 P2P",
        "Actual paired P2P",
        ["TTS", "LLM", "STT"],
        den["attempted"],
        den["correct"],
        den["failed"],
        den["timeouts"],
        source,
        analysis["latency"]["correctFullAudioOnly"],
        v["warmupsExcluded"],
        analysis["epochPolicy"],
    )

    active_base = C + "worker-desktop-k1-orca-relayed-http-first270-v2224/"
    frozen = load(active_base + "condition-frozen.json")
    active = load(active_base + "CURRENT.json")
    result = {
        "at": datetime.now(timezone.utc).isoformat(),
        "scope": "Only six worker-desktop service-boundary conditions; not full13, all surfaces, all directed pairs or all concurrency scenarios",
        "source": str(Path(__file__).relative_to(ROOT)),
        "sourceSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "newInference": 0,
        "newNetworkTraffic": 0,
        "crossConditionPercentilePooling": False,
        "conditions": rows,
        "sources": sources,
        "activeRequesterSnapshot": {
            "cohort": frozen["cohortId"],
            "lineage": frozen["epochLineage"],
            "custodySequence": active["sequence"],
            "copiedCases": len(active["completedCases"]),
            "outcomesByPhase": {
                phase: {
                    status: sum(
                        x["phase"] == phase and x["status"] == status
                        for x in active["completedCases"].values()
                    )
                    for status in ["completed_correct", "completed_incorrect", "failed"]
                }
                for phase in ["warmup", "measured"]
            },
            "note": "Point-in-time copied cases only; inflight and newer cases are not inferred",
        },
        "limitations": [
            "HTTP includes an Orca intermediary; no pure protocol-overhead claim",
            "No cross-host timestamp subtraction or averaging percentile summaries",
            "Reported timeout flags do not establish underlying transport causes",
            "Collection reaching900 does not establish acceptable correctness or complete the product goal",
        ],
    }
    out.mkdir(parents=True)
    (out / "inputs").mkdir()
    for path, raw in saved_inputs.items():
        assert shutil.disk_usage(ROOT).free - len(raw) > 2 * 1024**3
        path.write_bytes(raw)
        assert hashlib.sha256(path.read_bytes()).hexdigest() == path.stem
    (out / "INDEX-SOURCE-AS-EXECUTED.py").write_bytes(Path(__file__).read_bytes())
    (out / "inventory.json").write_text(json.dumps(result, indent=2) + "\n")
    lines = [
        "# Worker–desktop core conditions: saved-results index",
        "",
        result["scope"] + ".",
        "",
        "This index extracts retained results. It performs no inference or network requests and recomputes no historical quantiles.",
        "",
        "| Condition | Attempts /900 | Correct audio | Failed | Timeout flags within failures | Unattempted |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for row in rows:
        lines.append(
            "| "
            + " | ".join(
                str(row[k])
                for k in [
                    "condition",
                    "measuredAttempted",
                    "correctFullAudio",
                    "failedIncludingQualityAndTransport",
                    "timeoutsIncludedInFailed",
                    "unattempted",
                ]
            )
            + " |"
        )
    lines += [
        "",
        "The active K1HTTP epoch is recorded separately in inventory.json. Its270 planned attempts are not completed measurements; the original900 target remains open.",
        "",
        "Latency populations, milliseconds, per-epoch policies and input SHA256s are retained in inventory.json. No latency distributions are pooled by this index.",
        "",
        "Sources:",
        "",
    ]
    lines += ["- `" + row["condition"] + "`: `" + row["source"] + "`" for row in rows]
    lines += [
        "",
        "Reproduce with the same saved inputs:",
        "",
        "```bash",
        "python3 thesis/analysis/index_worker_desktop_core_v2229.py --output-dir thesis/results/<new-empty-directory>",
        "```",
        "",
        "To reproduce this exact saved snapshot, add `--input-inventory "
        + str((out / "inventory.json").relative_to(ROOT))
        + "`. All12 inputs are physically retained with hashes under inputs/. A run without that option reads the current saved reports and custody checkpoint.",
        "",
    ]
    (out / "README.md").write_text("\n".join(lines))
    print(
        json.dumps(
            {
                "output": str(out.relative_to(ROOT)),
                "conditions": len(rows),
                "closedAttemptTargets": sum(x["attemptTargetClosed"] for x in rows),
                "inputFiles": len(sources),
                "newInference": 0,
                "newNetworkTraffic": 0,
            }
        )
    )


if __name__ == "__main__":
    os.umask(0o077)
    main()
