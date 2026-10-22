# Post-terminal export and comparison

Run only after the existing campaign is terminal and Root has read its exact exit, cell receipts and cleanup results. Root keeps serial ownership and reuses the existing virtual environment. A partial or failed campaign is retained and exported; it is never relabeled as n300 success.

First verify the recorded approved tool hashes (exporter `34ccb4fd3ebac585813a043e53c7e0db8f59b85936f336e4ad8626bffc7c766e`; analyzer with owner-required descriptive p99 `42c42917b30df199c27476bcf66ae8abbf638157b39e25f3a11828e1326c5ed8`), and run the smallest syntax check. Then export this campaign and analyze that immutable export. The [V326 independent source review](terminal-analysis-v326-p99-sol-review.md) accepts the p99 change using the same samples and Type 7 helper; no extra test tier was added:

```sh
flock --nonblock /tmp/aurora-global-build.lock .venv/bin/python .git/aurora-handoff-import-20261006/matched-main-export-v320/export.py .git/aurora-handoff-import-20261006/matched-main-campaign-v317-6ce98ae97d594d9fafcd1ff9ad4b9b1c
flock --nonblock /tmp/aurora-global-build.lock .venv/bin/python .git/aurora-handoff-import-20261006/matched-main-analysis-v324/analyze.py docs/experiments/tcc-20261013-submission-20261030/root/matched-main-campaign-6ce98ae97d594d9fafcd1ff9ad4b9b1c
```

The exporter requires the actual terminal result and preserves statuses, safe raw records, provider captures, resource samples and source/owner-plan snapshots. Full browser reports and raw process logs remain private. The analyzer reuses the archived Type 7 helper and the archived105-capture validator; captured messages, validated model options and combined input hashes establish task/settings matching. Random per-cell private config hashes remain provenance. Missing parent workload/config fields stay unknown.

Report pooled successful-request p90/p95 as primary, and p50/p99 as secondary descriptive values, with n_success, n_total, failures, timeouts, cancellations, infeasibility and excluded warmups separately. Report the three counterbalanced session differences and observed session ranges. Three clusters support a descriptive view; no inferential interval, stable p99 or causal mesh-speedup claim follows from this campaign. Raw resource counters are total-host observations including the measured workload; background attribution is unknown.

Full300 eligibility requires nine completed cells, actual five warmups and100 measured rows each, captured provider matching and terminal source/protected/deadline gates. Inspect the emitted analysis before interpretation. Source review does not prove successful execution or final sample counts. No mobile/native voice, regional or thirteen-story completion is inferred.

The outer terminal handle33217 returned143 while the original timeout and driver remained live. That handle is retired. Observe the original PID1305953/start74126867 and actual campaign files. Read campaign-result.json when written; never treat outer tool143 as campaign termination. A Root observer receipt must distinguish actual driver result, observed process termination and any unavailable timeout exit code. No restart is required.
