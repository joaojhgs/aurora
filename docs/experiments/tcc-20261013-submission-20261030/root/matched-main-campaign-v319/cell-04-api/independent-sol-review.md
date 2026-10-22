# V342 independent API MAIN session 2 / cell 04 artifact review

2026-10-14 UTC. **APPROVE / PASS for actual closed API cell 04 and its final export**, campaign `6ce98ae97d594d9fafcd1ff9ad4b9b1c`. Actual native Sol result for Root relay. Same bounded artifact scope as accepted API cell 02: pure retained-data/hash/arithmetic inspection, no application/test/build/model/service/network/device/live-campaign execution or model reread. This report is the only owned write; canonical source/index, others' work, goals/ledger/vault, resources and continuing campaign were untouched.

Private source `.git/aurora-handoff-import-20261006/matched-main-campaign-v317-6ce98ae97d594d9fafcd1ff9ad4b9b1c/04-api`; export `docs/experiments/tcc-20261013-submission-20261030/root/matched-main-campaign-v319/cell-04-api`. Independently verified final export manifest SHA256 `948f0c8ce81ce8e3c7bc0f9460592879596f446b032f5f76997799a4379b176e`: all listed hashes and byte lengths match.

Actual result completed at `2026-10-14T11:39:15.053469+00:00`, child/final exit 0, elapsed `3441.906089172` seconds after the separate baseline; receipt validated=true, failure_classes=[], capture_join=request_ordinal. Final manifest marks main and the frozen options. All 105 unique request rows belong to one study session: first five correct warmups, then 100 correct measured requests. All exact-answer-v1 predicates passed with null errors, fixed 180000 ms deadline, zero other measured outcomes. Five warmups stay excluded from measured statistics; denominator is 100 observed requests.

All 105 captures independently satisfy ordinal/request_ordinal 0..104 and captured=true. Every capture matches messages `b65cbaff90f6dc8875d93914fc34a52d288427f7c28691ae7f8b15a8f6ae7fde`, validated options `2e8bc1ea2a932715d302bf954699fbe70526b8713fce3e461eb50f1c400dc7b9`, combined input `5a95a2f1b72dc76f3f875d7759c7926b3b06d4736e7a8a08fcc8144706b48fac`. All raw groups bind model `57d1997790d1744fba5b40a7317df71ea5e2acee28c47e78f0cce39c0703f8cf`, source `5782746afba213f6b36907db2f09f0017625e218`, workload `0f3b83f8fbf0e55e7b7faf8a75e99f42fdad42128b908e7f7c18cd4d8faeed86`, python_gateway_api route. Private configuration fingerprint `6217ab451bffcb9718dc935da9984762ffaf6c1d89f1d9774ad28ece738ba48a` matches this cell's manifest and remains separate from API cell 02's legitimately different complete configuration.

Independent Type 7 interpolation over the 100 measured monotonic reply durations gives milliseconds p50 `31975.320043`, p90 `36250.76030560001`, p95 `37587.2728986`; all match the actual group-wrapped summary. No warmups, history readback duration or total cell elapsed are substituted into reply latency.

Exported request/capture/resource/cleanup files are byte-identical to private originals; request-settings projection and its private-manifest hash agree, including the intentionally path-free capture projection. All campaign-listed archived/current source digests match. Current config.json/.env/uv.lock digests match campaign-before at inspection, without reading protected contents. This is inspection-time continuity, not a guarantee about future cells.

Log receipt retains private original hashes, 34 stdout credential-pattern lines withheld and zero stderr lines. Final redacted log hashes/lengths match and bounded pattern inspection found no obvious credential values; no values/log content are reproduced and no universal secret-detector guarantee is claimed. Supervisor cleanup remains `supervisor_returned_unverified`, with an empty detached-group list. Normal launcher exit does not establish all internal threads/services reaped.

Exact private/export anchors:

- Private result: `f5d13343cd95ee8609295dadda16c110e8a2fdad373eb70a3eace5c7a9301b4f`.
- Raw requests: `a581da30801319172e040fbcc521c2f9dda737a6e7dc408c6cb63439b7d5a678`.
- Provider captures: `fadc779e24b0adc04de7db6bc23581a321c8d7ee7636e6318ccb2adb1e5301af`.
- Private request manifest: `9776f8e3c19f59fa422fdfd87f138d62589bea7ff34a29d8b107c216aef7314c`.
- Export summary: `40f64d77b21815158730039dd646d65eac849819b2aec5498ca50c5b7c97b16e`.

This closes one loaded API MAIN session 2, n=100 measured. It does not close pooled n=300, entire nine-cell/goal acceptance, stable tails/p99, causal speedup, aesthetics, native/mobile/cross-region gates. No replay, extra iteration or matrix is recommended; Root owns its continuing serial campaign and subsequent analysis.
