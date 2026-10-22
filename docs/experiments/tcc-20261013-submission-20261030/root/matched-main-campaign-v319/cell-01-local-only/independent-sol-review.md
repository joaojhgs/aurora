# V327 independent completed MAIN cell 01 review

2026-10-14 UTC. **PASS for the actual first local-only MAIN cell and its retained data/export**, campaign `6ce98ae97d594d9fafcd1ff9ad4b9b1c`. Actual native Sol reviewer result for Root relay. This is artifact inspection and independent arithmetic/hash verification only; no application/analyzer/exporter/test/model/build/network/device execution, no campaign interference, and no canonical source/index/goal/ledger/vault writes. This report is the sole owned write.

## Actual completed cohort

Private source: `.git/aurora-handoff-import-20261006/matched-main-campaign-v317-6ce98ae97d594d9fafcd1ff9ad4b9b1c/01-local-only`. Its result records completed, child/final exit 0, elapsed `3301.3687037839554` seconds after the separate 300-second baseline, finished `2026-10-14T08:26:50.206878+00:00`. The main flags specify 5 warmups, 100 measured, 6000-second cap; the final manifest confirms measurement_tier main. This is not the prior two-request pilot.

Independently parsed all 105 raw rows: first 5 warmup=true, remaining 100 warmup=false; 105 unique request IDs, one study session; all exact-answer-v1 predicates passed, all error categories null, all declared deadlines 180000 ms. Both warmups and measured rows have correct_success outcomes. The measured denominator is exactly 100, with zero incorrect answers, failures, timeouts, cancellations, infeasibility or excluded measured rows. Five warmups are excluded from measurement; they are not fabricated outcome=excluded records.

All 105 provider captures independently satisfy ordinal/request_ordinal `0..104`, captured=true, and these exact frozen hashes:

- Messages: `b65cbaff90f6dc8875d93914fc34a52d288427f7c28691ae7f8b15a8f6ae7fde`.
- Validated options: `2e8bc1ea2a932715d302bf954699fbe70526b8713fce3e461eb50f1c400dc7b9`.
- Combined input: `5a95a2f1b72dc76f3f875d7759c7926b3b06d4736e7a8a08fcc8144706b48fac`.

All raw groups bind model `57d1997790d1744fba5b40a7317df71ea5e2acee28c47e78f0cce39c0703f8cf`, source `5782746afba213f6b36907db2f09f0017625e218`, workload `0f3b83f8fbf0e55e7b7faf8a75e99f42fdad42128b908e7f7c18cd4d8faeed86`, private config fingerprint `cd8f7071cc628b1c8bed3694e1362a6015144e7a92893f33866bf903add6ca79` and python_local_bus route. Generation settings retain 128 tokens, seed 42, two threads and the previously frozen remaining options. Model identity is verified through the actual retained manifest/raw bindings and pinned-runner admission proof; this review did not rerun or reload the model.

Sorting the 100 measured monotonic reply durations and independently applying Type 7 interpolation gives milliseconds: p50 `30492.3428095`, p90 `34627.554536100004`, p95 `36737.9242766`. These match the retained summary. Duration excludes persisted-history readback time as declared; correctness includes the existing exact reply/IDs/history main predicate. Total cell elapsed is not reply latency.

## Source, export and cleanup

Export: `docs/experiments/tcc-20261013-submission-20261030/root/matched-main-campaign-v319/cell-01-local-only`. Every listed export file hash matched its manifest. Exported raw requests, provider captures, resource rows and cleanup sidecar are byte-identical to the private originals. All campaign-listed source snapshot hashes matched both archive and current canonical source at inspection. Current config.json, .env and uv.lock hashes matched campaign-before hashes without reading their contents. This is an inspection-time continuity check, not a prediction about the remaining campaign.

The projected request settings omit raw workload text, private runtime paths and credentials; log receipts retain original hashes and explicitly withhold 34 credential-matching stdout lines, with zero stderr lines withheld. Exported redacted logs matched their recorded hashes and showed no obvious API-key/bearer/token-secret credential-value patterns in bounded content checks; no credential value or log/body content is reproduced here. This is a bounded actual-export check, not a universal secret detector claim.

Owned launcher exited normally and its detached-group cleanup list is empty. Actual cleanup sidecar says `supervisor_returned_unverified`; this review does not upgrade that to all internal threads/services reaped. The pre-shutdown manifest's cleanup observation is also unverified. Protected-file/source continuity and the completed main data are accepted within that honest cleanup scope.

## Exact anchors

- Private result.json: `7825bf0674fed8bc1fd4e805dd47b1143cb3f12a5b69618e3bd15e47b6211517`; redacted export result has its own manifest-listed hash.
- requests.jsonl: `b1bfa008775013ef1fd3d178a033289066d3f359daa15ff17e6bba8aedd2bbc2`.
- requests.jsonl.provider-inputs.jsonl: `fadc779e24b0adc04de7db6bc23581a321c8d7ee7636e6318ccb2adb1e5301af`.
- Private final request manifest: `cb5f40ad166bc6c989d3abf799620c6e9a3f6a44180c22288f1612bed00a0097`.
- Cleanup sidecar: `b520a0441c3f52026bcd3f44fdcd6bc0f737d8f220ed62460b82564c81af2c63`.
- Export manifest: `0aca8ed432ae0624b600fe5bd45637d2ce47118765e62ea3517f452952cfb797`.
- Maintained campaign runner: `c372126ca09f5f0f184f59fc7e2874f7f009125b210b1cc7ba4b96ce9141658f`.

This closes independent evidence review of one loaded local-only MAIN session, n=100 measured. Root's same campaign has advanced to API cell 02. No pooled n=300, full nine-cell success, route difference, stable tail/p99, causal performance, native/mobile/cross-region/aesthetic or complete multi-story acceptance is inferred. No rerun, additional matrix or new runtime is recommended.
