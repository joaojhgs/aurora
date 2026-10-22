# Desktop GPU typed Assistant measurements

**Status: Current bounded check.** Recorded October 14, 2026, at the owner's
request. This completes the desktop typed local/API components. Full individual
voice and surface acceptance remains unfinished, and cross-device measurements
remain held.

| Same-desktop condition | Correct / measured | Excluded warmups | p50 ms | p90 ms | p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Local bus | 900 / 900 | 15 | 5364.480 | 5457.406 | 5497.371 |
| Gateway HTTP | 900 / 900 | 15 | 5381.306 | 5582.345 | 5849.052 |

Each condition used three fresh processes, each with five warmups followed by
300 measured requests. All 1,800 measured requests returned the required exact
answer and passed persisted-history checks. Incorrect answers, failures,
timeouts, cancellations, infeasibility and unattempted measurements were zero
in both conditions. Warmups remain in the raw records and are excluded from
the quantiles. The complete typed block finished naturally at 20:43:53 UTC;
the later 20:44:51 check found all six drivers, launchers and the controller absent.

Quantiles use Type 7 linear interpolation over successful measured caller
durations: with sorted observations and `h = (n - 1) * p`, interpolate between
the adjacent observations. These are conditional reply-latency quantiles over
three process clusters per condition. They do not establish a stable tail,
confidence interval, causal hardware speedup or pure HTTP overhead. The worker
CPU cohort remains a separate extra control; no populations were pooled.

The workload requests the exact public answer `ORBIT`, using Qwen3.5-0.8B Q4_0
with model SHA256
`57d1997790d1744fba5b40a7317df71ea5e2acee28c47e78f0cce39c0703f8cf`.
Generation settings and per-epoch source/configuration/input-capture hashes are
in [summary.json](summary.json). The recorded source commit is `c0f4c0013cea5bb11ef81297194d0dc142a47bc4`
with the declared frozen overlays; later correlation changes were not part of
these measurements. The AMD RX 7600 has 8,573,157,376 bytes of VRAM. Each epoch's
log records 25/25 model layers offloaded through Vulkan. CPU-mapped buffers and
host work remain; this is not a claim that every computation ran on the GPU.

Reply latency ends at the typed reply. Persisted-history readback is a separate
correctness check. Raw stage observations provide LLM and history spans on the
same process monotonic clock. The roughly five-second pre-LLM gap remains
unclassified. STT, TTS, capture, render, first-token timing and physical playback
are unavailable in this typed control. Missing measurements are not zero.
Internal Supervisor cleanup remains unverified despite the observed process exits.

## Retained data

[projection-files.json](projection-files.json) indexes all six epochs and their
gzip request, stage and resource records. It records compressed and decoded byte
counts, SHA256 hashes and row counts; gzip timestamps are zero. The totals are
1,830 request records, 10,980 stage events and 9,976 resource samples. Request
and stage decoded bytes match the originals. Resources are projected to numeric
CPU, memory, GPU and DRM metrics. All compressed files and the summary are
covered by [public-projection-manifest.json](public-projection-manifest.json).

Examples: [local request records](data/local-only/epoch-1/requests.jsonl.gz),
[HTTP request records](data/api/epoch-1/requests.jsonl.gz),
[stage observations](data/local-only/epoch-1/requests.jsonl.stages.jsonl.gz),
[resource samples](data/local-only/epoch-1/resources.jsonl.gz).

The summary retains the six exact accelerator-offload log lines and original
private-log hashes. Full runtime logs, provider message captures, configuration
and environment contents remain private. The verified private archive has
SHA256 `510490b012dd80a031a41941bb5eddab8ce67024198f4601d0095a111b71137f`;
all 65 raw members were verified before analysis. Independent retained-data and
projection reviews passed. The manifest's draft status describes the reviewed
projection's provenance; these are the exact approved bytes copied into this
owner-requested experiment record, with no external publication.
