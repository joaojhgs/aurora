"""Extract six closed condition reports without inference or new quantiles."""

import argparse
import copy
import hashlib
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASELINE = "thesis/results/worker-desktop-core-v2231/inventory.json"
K1 = "thesis/results/worker-desktop-k1-http-full900-v2403/FULL900-SUMMARY.json"
FLOOR = 2 * 1024**3
MAX_INPUT = 1024**2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--input-inventory", type=Path)
    args = parser.parse_args()
    out = args.output_dir.resolve()
    assert out.is_relative_to(ROOT / "thesis") and not out.exists()
    prior = json.loads(args.input_inventory.read_bytes()) if args.input_inventory else None
    pinned = {x["path"]: x for x in prior["sources"]} if prior else {}
    sources, payloads = [], {}

    def load(relative, expected=None):
        path = ROOT / pinned[relative]["physicalSnapshot"] if pinned else ROOT / relative
        assert path.resolve().is_relative_to(ROOT / "thesis")
        before = path.stat()
        assert before.st_size <= MAX_INPUT
        raw = path.read_bytes()
        after = path.stat()
        assert before.st_size == len(raw) == after.st_size
        assert before.st_mtime_ns == after.st_mtime_ns
        digest = hashlib.sha256(raw).hexdigest()
        if expected:
            assert digest == expected
        if pinned:
            assert digest == pinned[relative]["sha256"]
        payloads[digest] = raw
        sources.append({"path": relative, "bytes": len(raw), "sha256": digest,
                        "physicalSnapshot": str((out / "inputs" / (digest + ".json")).relative_to(ROOT))})
        return json.loads(raw)

    baseline = load(BASELINE)
    closed = load(K1, "cc803a992a86d9b15c41e2c6b5f01f6e4400360f0ad61a5f54f4b1dff041dbdc")
    rows = copy.deepcopy(baseline["conditions"])
    assert [x["condition"] for x in rows] == ["K1 HTTP", "K1 P2P", "K2 HTTP", "K2 P2P", "K3 HTTP", "K3 P2P"]
    assert closed["conditionIndices"] == {"min": 1, "max": 900, "unique": 900, "gaps": [], "duplicates": []}
    for source in baseline["sources"]:
        if source["path"] == rows[0]["source"] or "first270-v2224/" in source["path"]:
            continue
        load(source["path"], source["sha256"])
    den = closed["measured"]
    rows[0].update({
        "source": K1, "measuredAttempted": den["attempted"],
        "correctFullAudio": den["correct"], "failedIncludingQualityAndTransport": den["failed"],
        "timeoutsIncludedInFailed": den["timeouts"], "unattempted": den["unattempted"],
        "excludedWarmups": closed["excludedWarmups"], "attemptTargetClosed": True,
        "retainedLatencyStatistics": {x["epoch"]: x["correctOnlyLatencyMs"] for x in closed["epochs"]},
        "latencyPolicy": closed["latencyPolicy"],
        "epochMetricsBasis": {x["epoch"]: x["metricsBasis"] for x in closed["epochs"]},
        "quantileMethod": closed["quantileMethod"],
    })
    for row in rows:
        assert row["measuredAttempted"] == row["correctFullAudio"] + row["failedIncludingQualityAndTransport"] == 900
        assert row["unattempted"] == 0 and row["attemptTargetClosed"]
        assert 0 <= row["timeoutsIncludedInFailed"] <= row["failedIncludingQualityAndTransport"]
    result = {
        "at": datetime.now(timezone.utc).isoformat(),
        "scope": baseline["scope"], "status": "SIX_ATTEMPT_TARGETS_CLOSED_NOT_FULL_MATRIX_OR_PRODUCT_ACCEPTANCE",
        "source": str(Path(__file__).relative_to(ROOT)),
        "sourceSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "newInference": 0, "newNetworkTraffic": 0, "newRawQuantileComputations": 0,
        "crossConditionPercentilePooling": False, "conditions": rows, "sources": sources,
        "limitations": baseline["limitations"] + [
            "K1 HTTP supersedes the earlier index's partial180 count only; original files are preserved",
            "Source-reported percentiles are copied exactly, never averaged; K1 epoch settings/residency differ",
            "Tables are machine-extracted descriptive records for owner review, not a scientific acceptance or submission approval",
            "Active mixed-load C12, phone/notebook, other surfaces/pairs and remaining full13 work are outside this closed-condition index",
        ],
    }
    lines = ["# Six closed worker–desktop conditions", "", result["scope"] + ".", "",
             "Saved-report extraction for owner review; no inference, network traffic, new quantiles or historical reruns.", "",
             "| Condition | Attempts | Correct audio | Failed | Timeout flags within failures |",
             "| --- | ---: | ---: | ---: | ---: |"]
    for row in rows:
        lines.append("| " + " | ".join(str(row[k]) for k in ["condition", "measuredAttempted", "correctFullAudio", "failedIncludingQualityAndTransport", "timeoutsIncludedInFailed"]) + " |")
    lines += ["", "Successful full-audio latency, milliseconds. Each row uses its own successful-response denominator and retained Hyndman–Fan Type7 statistics. Failed attempts remain in the outcome table. K1 epoch distributions remain separate; other rows preserve their source's declared population policy.", "",
              "| Condition / epoch | Successful n | p50 ms | p90 ms | p95 ms |",
              "| --- | ---: | ---: | ---: | ---: |"]
    for row in rows:
        stats = row["retainedLatencyStatistics"]
        strata = stats.items() if row["condition"].startswith("K1 ") else [("", stats)]
        for epoch, values in strata:
            count = values.get("denominator", values.get("n"))
            assert isinstance(count, int) and count > 0
            qs = [values.get(k + "_ms", values.get(k)) for k in ["p50", "p90", "p95"]]
            assert all(isinstance(x, (int, float)) for x in qs)
            lines.append("| " + " | ".join([row["condition"] + (" / " + epoch if epoch else ""), str(count)] + [str(x) for x in qs]) + " |")
    lines += ["", "HTTP includes the existing Orca intermediary; these results do not isolate protocol overhead or establish a causal transport-speed advantage. K1 source/authorization/model-residency epochs are not pooled. K1 V1197 statistics are retained original aggregates; later K1 epochs were recomputed by their named saved-data analyzers. This index recomputes none.", "",
              "All inputs are physically retained under inputs/ with SHA256s in inventory.json. Existing raw case/stage/audio/resource histories remain at their canonical thesis paths, referenced by those reports. No old index or failed case is replaced.", "", "Sources:", ""]
    lines += ["- " + row["condition"] + ": `" + row["source"] + "`" for row in rows]
    lines += ["", "Reproduce the exact saved extraction into a new empty directory:", "", "```bash",
              "python3 " + result["source"] + " --input-inventory " + str((out / "inventory.json").relative_to(ROOT)) + " --output-dir thesis/results/<new-empty-directory>", "```", ""]
    assert sum(map(len, payloads.values())) < 2 * MAX_INPUT
    assert shutil.disk_usage(ROOT).free > FLOOR + sum(map(len, payloads.values())) + MAX_INPUT
    out.mkdir(parents=True)
    (out / "inputs").mkdir()
    for digest, raw in payloads.items():
        path = out / "inputs" / (digest + ".json")
        path.write_bytes(raw)
        assert hashlib.sha256(path.read_bytes()).hexdigest() == digest
    (out / "INDEX-SOURCE-AS-EXECUTED.py").write_bytes(Path(__file__).read_bytes())
    (out / "inventory.json").write_text(json.dumps(result, indent=2) + "\n")
    (out / "README.md").write_text("\n".join(lines))
    print(json.dumps({"output": str(out.relative_to(ROOT)), "closedConditions": len(rows),
                      "measuredAttempts": sum(x["measuredAttempted"] for x in rows),
                      "physicalInputFiles": len(payloads), "inputBytes": sum(map(len, payloads.values())),
                      "newInferenceOrNetwork": 0, "newQuantileComputations": 0}))


if __name__ == "__main__":
    os.umask(0o077)
    main()
