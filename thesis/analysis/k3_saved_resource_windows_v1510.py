"""Summarize recorded K3 terminal-partial resource windows; never import or call Aurora."""

import argparse
from bisect import bisect_left, bisect_right
from collections import Counter, defaultdict
from datetime import datetime, timezone
import json
from pathlib import Path
import time

from k1_saved_case_history import finite, sha, write_once
from native_span_metrics_v2 import type7


REPO = Path(__file__).resolve().parents[2]
IDENTITIES = {"requester": (968825, 109025741), "provider": (1227894, 6621473)}


def resource_distribution(values, unit):
    values = [float(value) for value in values if finite(value)]
    return {"denominator": len(values), "unit": unit,
            "p50": type7(values, .5), "p90": type7(values, .9), "p95": type7(values, .95)}


def load_resources(host, state, locations, sources, deadline):
    """Read the selected immutable prefix once, checking every chunk identity."""
    prefix = state["prefixes"]["resources.jsonl"]
    rows, position, carry = [], 0, b""
    skipped = Counter()
    pid, ticks = IDENTITIES[host]
    for name in prefix["chunks"]:
        assert time.monotonic() < deadline, "Saved-data read exceeded its finite cap"
        if host == "provider":
            record = state["files"][name]
            path = REPO / locations[name]["path"]
        else:
            path = REPO / name
            record = next(v for v in state["files"].values() if v["destination"] == name)
        assert path.is_relative_to(REPO / "thesis") and path.resolve(strict=True) == path
        data = path.read_bytes()
        assert len(data) == record["bytes"] and sha(data) == record["sha256"]
        assert record["startByte"] == position
        position = record["endByte"]
        sources.append({"path": str(path), "bytes": len(data), "sha256": record["sha256"]})
        lines = (carry + data).split(b"\n")
        carry = lines.pop()
        for line in lines:
            if not line.strip():
                continue
            value = json.loads(line)
            context = value.get("resource_context", {})
            proc = context.get("child_proc_stat") or {}
            if context.get("pid") != pid or proc.get("startTicks") != ticks:
                skipped["otherOrAbsentOriginalProcess"] += 1
                continue
            stamp = context.get("monotonic_ns")
            if not isinstance(stamp, int):
                skipped["missingRecordedMonotonicTimestamp"] += 1
                continue
            status = context.get("child_status") or {}
            rows.append({"t": stamp, "ticks": proc.get("userCpuTicks", 0) + proc.get("systemCpuTicks", 0),
                         "ticksPerSecond": context.get("ticks_per_second"),
                         "rssKb": status.get("VmRSS"),
                         "availableBytes": value.get("mem_available_bytes", value.get("mem_available")),
                         "gpu": context.get("amd_drm_devices", []),
                         "network": (context.get("child_network") or {}).get("interfaces", {}),
                         "networkScope": (context.get("child_network") or {}).get("scope"),
                         "errors": [e.get("field", "unknown") for e in context.get("counter_errors", [])]})
    assert position == prefix["endByte"]
    rows.sort(key=lambda x: x["t"])
    return rows, {"retainedSamples": len(rows), "skipped": dict(skipped),
                  "trailingUnterminatedBytesExcluded": len(carry), "prefixEndByte": position,
                  "networkScopes": sorted({str(x["networkScope"]) for x in rows})}


def numeric(values):
    return [x for x in values if isinstance(x, (int, float)) and not isinstance(x, bool)]


def window(rows, times, start, end):
    """Associate samples inside one same-host interval, without interpolation."""
    selected = rows[bisect_left(times, start):bisect_right(times, end)]
    result = {"startMonotonicNs": str(start), "endMonotonicNs": str(end),
              "sampleCount": len(selected), "processCpuSecondsObserved": None,
              "meanCpuCoresOverObservedSpan": None, "peakProcessVmRSS_kB": None,
              "minimumHostAvailableMemoryBytes": None, "gpu": {}, "networkNamespaceDeltas": {},
              "counterErrors": dict(Counter(e for x in selected for e in x["errors"]))}
    if not selected:
        return result
    rss = numeric([x["rssKb"] for x in selected])
    available = numeric([x["availableBytes"] for x in selected])
    result["peakProcessVmRSS_kB"] = max(rss) if rss else None
    result["minimumHostAvailableMemoryBytes"] = min(available) if available else None
    first, last = selected[0], selected[-1]
    if len(selected) >= 2 and last["t"] > first["t"] and first["ticksPerSecond"] == last["ticksPerSecond"]:
        rate, delta = first["ticksPerSecond"], last["ticks"] - first["ticks"]
        if isinstance(rate, (int, float)) and rate > 0 and delta >= 0:
            cpu = delta / rate
            result["processCpuSecondsObserved"] = cpu
            result["meanCpuCoresOverObservedSpan"] = cpu / ((last["t"] - first["t"]) / 1e9)
        for name in first["network"].keys() & last["network"].keys():
            values = {}
            for field in ("rx_bytes", "tx_bytes", "rx_packets", "tx_packets"):
                a, b = first["network"][name].get(field), last["network"][name].get(field)
                values[field] = b - a if isinstance(a, int) and isinstance(b, int) and b >= a else None
            result["networkNamespaceDeltas"][name] = values
    devices = defaultdict(list)
    for sample in selected:
        for device in sample["gpu"]:
            devices[str(device["device"])].append(device)
    for name, values in devices.items():
        busy = numeric([x.get("gpu_busy_percent") for x in values])
        vram = numeric([x.get("mem_info_vram_used") for x in values])
        result["gpu"][name] = {"samples": len(values), "busySamples": len(busy),
                               "maximumBusyPercent": max(busy) if busy else None,
                               "maximumObservedVRAMBytes": max(vram) if vram else None}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case-history", type=Path, required=True)
    parser.add_argument("--requester-snapshot", type=Path, required=True)
    parser.add_argument("--provider-snapshot", type=Path, required=True)
    parser.add_argument("--provider-coverage-chain", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    started, deadline = time.monotonic(), time.monotonic() + 120
    output = args.output_dir.resolve()
    assert output.is_relative_to(REPO / "thesis") and not output.exists()
    sources = []
    def read(path):
        raw = path.read_bytes()
        sources.append({"path": str(path.resolve()), "bytes": len(raw), "sha256": sha(raw)})
        return json.loads(raw)
    history = read(args.case_history)
    states = {"requester": read(args.requester_snapshot), "provider": read(args.provider_snapshot)}
    chain = read(args.provider_coverage_chain)
    assert chain["checkpointSequence"] == states["provider"]["sequence"]
    resources, clocks, custody = {}, {}, {}
    for host in IDENTITIES:
        resources[host], custody[host] = load_resources(host, states[host], chain["resolvedFiles"], sources, deadline)
        clocks[host] = [x["t"] for x in resources[host]]
    cases, grouped = {}, defaultdict(list)
    for name, case in history.items():
        if case["phase"] != "measured":
            continue
        bounds = {"requester.full_attempt": ("requester", int(case["flowStartedMonotonicNs"]), int(case["flowEndedMonotonicNs"]))}
        provider_spans = [x for x in case["nativeSpans"] if x["host"] == "provider"]
        if provider_spans:
            bounds["provider.native_case_window"] = ("provider", min(int(x["startMonotonicNs"]) for x in provider_spans), max(int(x["endMonotonicNs"]) for x in provider_spans))
        for host, handler, label in (("provider", "stt.model_invoke", "provider.stt_model"),
                                     ("provider", "resolved_chat_model.astream", "provider.llm_model"),
                                     ("provider", "tts.model_invoke", "provider.tts_model")):
            spans = [x for x in case["nativeSpans"] if x["host"] == host and x["handler"] == handler]
            if len(spans) == 1:
                x = spans[0]
                assert x["clockDomain"] == "python_process_monotonic" and x["receiverPid"] == IDENTITIES[host][0]
                bounds[label] = (host, int(x["startMonotonicNs"]), int(x["endMonotonicNs"]))
        values = {label: window(resources[host], clocks[host], a, b) for label, (host, a, b) in bounds.items()}
        cases[name] = {"status": case["status"], "windows": values}
        for label, value in values.items():
            grouped[label].append(value)
    summaries = {}
    for label, rows in grouped.items():
        summaries[label] = {"measuredCaseDenominator": len(cases), "casesWithNativeWindow": len(rows),
                            "casesWithSamples": sum(x["sampleCount"] > 0 for x in rows),
                            "casesWithTwoSamples": sum(x["sampleCount"] >= 2 for x in rows),
                            "resourceQuantiles": {key: resource_distribution([x[key] for x in rows], unit) for key, unit in [("processCpuSecondsObserved", "s"), ("meanCpuCoresOverObservedSpan", "CPU cores"), ("peakProcessVmRSS_kB", "KiB"), ("minimumHostAvailableMemoryBytes", "bytes")]}}
    assert len(cases) == states["requester"]["progressObservation"]["measured_attempted"] == 513
    summary = {"schema": "aurora.k3.saved-resource-windows.v1", "at": datetime.now(timezone.utc).isoformat(),
               "analysisSourceSha256": sha(Path(__file__).read_bytes()), "measured": len(cases),
               "outcomes": dict(Counter(x["status"] for x in cases.values())), "resources": custody, "windows": summaries,
               "quantileMethod": "Hyndman-Fan Type7, h=(n-1)*p, linear interpolation; resource units follow each field name, not latency milliseconds",
               "clockPolicy": "Recorded same-host Python monotonic timestamps only. No cross-host subtraction or interpolation.",
               "scope": "Samples inside actual case/model intervals, not exclusive per-request resource attribution. Parent receiver CPU excludes separately spawned Piper processes. Network counters are namespace-wide; interfaces are separate and must not be summed. GPU observations are per recorded DRM device. Missing/unsupported or unsampled fields stay null. Short model windows can have zero samples.",
               "seconds": time.monotonic() - started, "newMeasurements": 0, "sutCalls": 0}
    output.mkdir(parents=True)
    write_once(output / "SUMMARY.json", summary)
    write_once(output / "RESOURCE-CASE-HISTORY.json", cases)
    write_once(output / "SOURCE-IDENTITIES.json", sources)
    print(json.dumps({"output": str(output), "measured": len(cases), "seconds": summary["seconds"],
                      "coverage": {k: {x: v[x] for x in ("casesWithNativeWindow", "casesWithSamples", "casesWithTwoSamples")} for k, v in summaries.items()}, "sutCalls": 0}))


if __name__ == "__main__":
    main()
