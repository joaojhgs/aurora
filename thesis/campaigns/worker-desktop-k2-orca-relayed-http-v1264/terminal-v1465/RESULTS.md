# K2 worker-to-Personal HTTP file-audio results

Collection ended naturally at 2026-10-18T06:48:13.987269+00:00, exit1. **900 measured requests:797 correctly completed,103 strict answer-format failures,0 timeout flags,0 unattempted.** All15 ordinary warmups passed and are excluded. This is one fixed end-to-end workload measured900 times; the full Aurora objective remains open.

The route is the existing Orca-relayed HTTP application route. STT runs on the worker; LLM and explicit TTS run on the original Personal receiver. The frozen condition remains `b15a49adffc5aaa43b426563d5776fa384c92f58e339030b69cb3877e98f2399`; original provider manifest450ee5af and process identities matched before/after the post-run export.

All103 failed reply hashes match “The capital of France is Paris.” (31characters), while the frozen criterion requires only “Paris”. They remain failures under the original predicate; the harness stopped them before explicit TTS. The reason for the change in reply format was not investigated. There is no inferred transport or model-runtime outage. [Hash classification](FAILURE-HASH-CLASSIFICATION-v1470.json).

Quantiles are milliseconds, Hyndman–Fan Type7: h=(n−1)p with linear interpolation. Correct full-flow latency ends after actual valid non-silent PCM16 output audio is received, decoded and checked. Failed attempts end earlier and remain in the900-request outcome denominator; their shorter durations are not full-flow success latencies.

| Boundary | n | p50 ms | p90 ms | p95 ms |
| --- | ---: | ---: | ---: | ---: |
| Correct complete audio flow | 797 | 28967.941 | 31730.103 | 33246.103 |
| Requester STT wrapper | 900 | 8383.424 | 10891.939 | 12174.689 |
| Requester remote Assistant wrapper | 900 | 11857.376 | 13050.754 | 13435.889 |
| Requester remote TTS wrapper | 797 | 8240.458 | 9104.014 | 9412.779 |
| Native worker STT model | 900 | 8242.751 | 10674.757 | 11976.274 |
| Native Personal LLM model | 900 | 263.040 | 402.651 | 1222.316 |
| Native Personal TTS model | 797 | 1692.072 | 2004.529 | 2183.714 |

Native STT service/model spans join all900 measured cases. Native Personal LLM spans join all900, and history has1800 completed invocations across900 cases. Native TTS service/model spans join exactly797 invoked cases; the103 pre-TTS failures have no TTS invocation to join. Native operation/request/session identifiers are absent at some boundaries and remain absent in the raw report; actual unique case/Gateway correlations bind the spans. Service and model spans are reported separately.

Recorded samples are present inside the requester’s full-attempt interval for900/900 cases and inside the provider’s native-span envelope for900/900 cases; these are separate same-host windows. Worker STT model windows contain samples for900/900 cases. The sub-second Personal LLM windows contain samples for285/900 cases and at least two samples for29/900; TTS has samples for797/797 invoked cases and at least two for583/797. Unsampled CPU/GPU values stay unknown. [Resource summaries with explicit units](resource-analysis-v1471/SUMMARY-UNITS.json), [resource case history](resource-analysis-v1471/RESOURCE-CASE-HISTORY.json).

Samples inside actual case/model intervals, not exclusive per-request resource attribution. Parent receiver CPU excludes separately spawned Piper processes. Network counters are namespace-wide; interfaces are separate and must not be summed. GPU observations are per recorded DRM device. Missing/unsupported or unsampled fields stay null. Short model windows can have zero samples.

Only same-host recorded monotonic clocks are paired. No cross-host timestamp subtraction, sum of independent percentiles or pure protocol-overhead claim is made. Queue, first-token, first-audio and physical playback timing remain unknown. This is file-audio service-boundary evidence; it does not establish microphone, Android/iOS UI, browser or physical playback acceptance.

Physical custody now resolves915 requester case records and812 unique WAVs (797correct measured+15warmups). Provider data resolves1763 physical raw files/214,494,313bytes across five retained copies. The last transfer added1222 files/120,866,380bytes; zero baseline raw was copied again. Original source data and earlier failures/checkpoints remain intact. The shared provider sampler still runs; its generic incomplete flags are preserved, while the selected K2 case/stage coverage is verified here.

[Final validation](FINAL-VALIDATION-v1472.json), [requester seal](SEAL.json), [latency/native summary](analysis-v1469/SUMMARY.json), [case history](analysis-v1469/CASE-HISTORY.json), [source identities](analysis-v1469/SOURCE-IDENTITIES.json). The unchanged latency analyzer retains its conservative fixed checkpoint status label; the separate final validation binds its actual900-case output to the terminal seal and native coverage.

Reproduce from saved data only into new output directories:

```bash
nice -n 15 python3 thesis/analysis/k2_saved_case_history.py \
  --requester-custody /home/developer/projects/aurora/thesis/campaigns/worker-desktop-k2-orca-relayed-http-v1264 \
  --requester-snapshot thesis/campaigns/worker-desktop-k2-orca-relayed-http-v1264/terminal-v1465/REQUESTER-CURRENT.json \
  --provider-extracted thesis/evidence/orca-relayed-http-v1197/provider-transfer-delta-v1468/extracted \
  --provider-coverage-chain thesis/evidence/orca-relayed-http-v1197/provider-transfer-delta-v1468/COVERAGE-CHAIN.json \
  --output-dir thesis/campaigns/worker-desktop-k2-orca-relayed-http-v1264/terminal-v1465/new-latency-analysis
```

The resource entrypoint is `thesis/analysis/k2_saved_resource_windows.py`, with `--case-history`, `--requester-snapshot`, `--provider-snapshot`, `--provider-coverage-chain` and a new `--output-dir`. The exact executed source is also retained in `resource-analysis-v1471/ANALYSIS-SOURCE-AS-EXECUTED.py`. Its shared helper used latency-style quantile key names for resource units; `SUMMARY-UNITS.json` corrects only those labels, and20 actual saved metric distributions were checked equivalent against the corrected entrypoint. The original summary and executed source remain intact.
