# V334 independent completed API MAIN cell 02 review

2026-10-14 UTC. **APPROVE / PASS for actual closed cell 02 API data and final export**, campaign `6ce98ae97d594d9fafcd1ff9ad4b9b1c`. Actual native Sol reviewer result for Root relay. Scope reuses cell 01's bounded artifact/count/hash/arithmetic review; no application, campaign, model, tests, builds, services, network or device execution. Pure filesystem/data inspection only. This sole private report is the only owned write; live mesh/campaign, frozen source/index, goal/ledger/vault and others' work were untouched.

Private source: `.git/aurora-handoff-import-20261006/matched-main-campaign-v317-6ce98ae97d594d9fafcd1ff9ad4b9b1c/02-api`. Final export: `docs/experiments/tcc-20261013-submission-20261030/root/matched-main-campaign-v319/cell-02-api`. Independently verified FINAL export manifest SHA256 `2a5b5bd1ee56b3b6db146445df8d0c2b15b4ccee3f59def26522c32ddb9c8b31`; all its listed file hashes and byte lengths match, including retained initial README/manifest history.

The actual result is completed, child/final exit 0, receipt validated=true/no failure classes, elapsed `3420.9904636449646` seconds after the separate 300-second baseline, finished `2026-10-14T09:28:51.397408+00:00`. Driver flags/final manifest identify main, 5 warmups/100 measured and 6000-second cap.

Independently parsed all 105 rows: 105 unique request IDs, one study session, first 5 warmup=true and subsequent 100 measured; all 105 correct_success/exact-answer-v1/predicate_passed=true/error_category=null, fixed deadline 180000 ms. Measured denominator 100, success 100, zero incorrect answers/failures/timeouts/cancellations/infeasibility/excluded measured outcomes. Warmups remain observed correct rows excluded from quantiles, not synthetic excluded-outcome records.

All 105 captures independently match ordinal/request_ordinal 0..104 and captured=true, messages SHA256 `b65cbaff90f6dc8875d93914fc34a52d288427f7c28691ae7f8b15a8f6ae7fde`, validated options `2e8bc1ea2a932715d302bf954699fbe70526b8713fce3e461eb50f1c400dc7b9`, combined input `5a95a2f1b72dc76f3f875d7759c7926b3b06d4736e7a8a08fcc8144706b48fac`. Every raw group binds model `57d1997790d1744fba5b40a7317df71ea5e2acee28c47e78f0cce39c0703f8cf`, source `5782746afba213f6b36907db2f09f0017625e218`, workload `0f3b83f8fbf0e55e7b7faf8a75e99f42fdad42128b908e7f7c18cd4d8faeed86`, supported raw route python_gateway_api. The independently retained private-config fingerprint is `d25b83fe8940fab7e64464528edaf8e4266b31c1b9e84f71c5a717af6aeaa8b8`; it is not equated to local cell 01's complete config. Model was not reread/reloaded; these are actual manifest/raw/pinned-admission bindings.

Independent Type 7 interpolation over the 100 successful measured monotonic reply durations gives milliseconds: p50 `31676.288347`, p90 `36514.1530597`, p95 `38343.7825114`. All exactly match the actual single-group summary within floating arithmetic tolerance. Final README displays these values; initial null-quantile reporting and its initial manifest are preserved explicitly. Raw/summary data did not change for that reporting correction. This is one loaded session, not total elapsed interpreted as reply latency or an n=300 pooled result.

Private/export request rows, captures, resources and cleanup sidecar are byte-identical. Projected settings equal corresponding private manifest fields; provider_input_capture intentionally omits its artifact path and keeps matching hash/context_verified. All campaign-listed archive/current source hashes matched, and current config.json/.env/uv.lock digests matched campaign-before at inspection, without reading protected file contents. Resource counters are whole-host observations with unknown background attribution, not a clean/exclusive host claim.

Log receipts record 34 stdout credential-pattern lines withheld, zero stderr lines, original private hashes and separate exported hashes. Both redacted files match their final manifest and show no obvious API-key/bearer/token-secret values in bounded pattern inspection. No credential/log/body content is reproduced; this is not a universal secret detector guarantee. Cleanup sidecar remains supervisor_returned_unverified and detached groups are empty: normal launcher completion is accepted without inferring all internal threads/services reaped.

Exact anchors:

- Private result.json: `100dcee716ebb283923d95b58cef329884e1624f5e3bdccf2ec48ac3844c9926`.
- requests.jsonl: `4550463315d2a34e2d95f3dfb555c4d75f7a540ca192640d6a02de0fe0776b39`.
- Provider captures: `fadc779e24b0adc04de7db6bc23581a321c8d7ee7636e6318ccb2adb1e5301af`.
- Private request manifest: `b556e12ac68922f54944fba32dddeb12c560785f1977985ea0b9e69ac3ed154b`.
- Export summary: `95d9162eabe1844ebc5bd561978ed203f98e212f1fa6232c9a3cbdcbb13726b2`.
- Cleanup sidecar: `b520a0441c3f52026bcd3f44fdcd6bc0f737d8f220ed62460b82564c81af2c63`.

This closes independent review of one actual API MAIN session, n=100 measured. No replay, new matrix or runtime is recommended. Three-session pooled acceptance, entire nine-cell/goal completion, stable tails/p99, causal comparison, aesthetics, native/mobile/cross-region acceptance remain outside this verdict. Root's existing serial campaign owns subsequent cells.
