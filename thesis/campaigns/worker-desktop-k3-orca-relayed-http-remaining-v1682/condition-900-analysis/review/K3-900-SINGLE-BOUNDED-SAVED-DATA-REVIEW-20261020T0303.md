# K3 900-attempt saved-data review: PASS within the requested scope

Original Root request msg_d0dd83591cc7, Run run_e6054e76e9fc; existing monitor Task task_d7ea336050cf / Dispatch ctx_37b4d0a3c14f. One bounded read-only review, completed20October2026UTC. This review is NOT a P2P admission gate and creates no new experiment, model call, audio decode, source edit or worker.

## Question

Does the named K3 condition analyzer accurately preserve and consolidate the four eligible retained epochs, with explicit failure/sample accounting, same recorded scientific descriptors and correctly calculated latency quantiles?

## Ranked synthesis

| Rank | Finding | Confidence | Basis |
|---|---|---|---|
|1 |Numeric and raw-source accounting passes for the retained900-attempt dataset |High |All900 source rows rehashed and parsed; zero hash/content mismatches; exactly900unique global/case/correlation IDs, no warmups included |
|2 |The descriptive raw-row union is supported by the recorded frozen descriptors, with four epoch strata retained |High for recorded artifacts; limited for broader runtime claims |21equal scientific manifest fields, exact per-epoch config/candidate bindings in every row, hash-bound config witnesses; only local token migration excluded |
|3 |The result supports a conditional correct-response latency distribution, not900successes, a stationary uninterrupted run or causal protocol/GPU advantage |High |885correct,12strict-format failures and3transport-ambiguous failures remain in900denominator; four lifecycles/time windows visible |

No blocking error was found in the requested script/data/report scope. Stop this review after this report; no further test/review matrix or closed-cohort replay is indicated.

## Evidence

- thesis/analysis/k3_condition_900_v1682.py:19 defines21selected scientific descriptors; :53 compares complete projected nested values, and :57 binds retained config witnesses to exact manifests/summaries. :66 excludes only services.gateway.api.token_secret when constructing the original normalization witness.
- The900raw rows and all900 referenced retained case files were independently compared. Global indices are1–900 without duplication; case IDs and correlation IDs are independently unique. All rows are measured. Every correct response has all_expected=true, completedSTT/assistant/TTS stages and an output-audio hash. This reviews saved validity records, not a fresh WAV decode or speech-quality assessment.
- Epoch counts remain V1481=513, V1513=203, V1620=24, V1682=160. Their correct counts are512,202,11,160. All900 row config hashes/candidate-manifest hashes agree with their own retained epoch summaries. All referenced manifest/summary hashes and all four witness-to-summary bindings pass.
- Independent Hyndman–Fan Type7 calculation on885correct flow durations exactly reproduces p50=30277.170251ms, p90=31243.1636454ms, p95=31787.947598400002ms. All900durations are finite/nonnegative and agree with each row's same-clock monotonic start/end interval. Epoch quantiles were not averaged.
- All900timeout fields exist and are false. These are harness timeout flags; transport_ambiguous does not establish the underlying transport cause. There are12partial-quality failures and3transport-ambiguous failures, all retained.
- The current analyzer source hash equals SUMMARY.analysisSourceSha256. Imported helper versions are pinned below; the independent quantile calculation did not call those helpers.
- The new final-epoch native/resource summaries record160completed model-stage joins perSTT/LLM/TTS and160requester/provider windows. Their null/sparse fields remain explicit. The final RESULTS.md correctly limits native/resource statements to the final epoch and names STTCPU/int8_float32, LLMVulkan25/25 andPiperCPU.

## Inference and limits

Recorded descriptors and documented auth-only config normalization support this descriptive same-condition union. V1481 has a frozen INPUT config witness, not a retained post-startup config snapshot; its startup-change summary supplies the narrower recorded claim. This review did not independently read private config values or recertify historical model hardware/resource isolation. Preserve that witness limit and epoch/load/restart context; do not infer IID/stationarity, raw-only network overhead or a causal GPU effect from the pooled descriptive percentiles. Older native/resource reports remain separately scoped.

Two non-blocking documentation clarifications: the saved-data reproduction command's output directory must be a NEW path under repository thesis/ (the script enforces this); an explicit example is --output-dir thesis/reproductions/k3-condition900-review-YYYYMMDD. Label the zero timeout count as zero HARNESS-FLAGGED timeouts; underlying cause of the three transport-ambiguous outcomes remains unestablished. Neither clarification requires another benchmark, source investigation loop or P2P delay.

## Exact versions and receipt

- `thesis/analysis/k3_condition_900_v1682.py` — 10121bytes; SHA256`fcc27e6a8f44ae8933bbcde2460291809908cbf812b296bd9dc40d6339519937`.
- `thesis/analysis/k1_saved_case_history.py` — 18039bytes; SHA256`4a406dd330e2396d38a6ce3b8b5a38362a7727058aff644d0232bdff54474608`.
- `thesis/analysis/native_span_metrics_v2.py` — 5210bytes; SHA256`b8fc433bae6e941bd8829df1fa65a5df42af94f2a45d1f3e7174aca8767a7932`.
- `thesis/campaigns/worker-desktop-k3-orca-relayed-http-remaining-v1682/condition-900-analysis/SUMMARY.json` — 7307bytes; SHA256`d0442026536ce0582e1b7ff87307e05ff125be3b6f468848e7867fc6ab67886b`.
- `thesis/campaigns/worker-desktop-k3-orca-relayed-http-remaining-v1682/condition-900-analysis/CONFIG-COMPARABILITY-WITNESSES.json` — 3058bytes; SHA256`f0b32d9d9a3a84b1b3a8ec56c0659a2d218a54b7cf141618c51a2a6b9d7e3adf`.
- `thesis/campaigns/worker-desktop-k3-orca-relayed-http-remaining-v1682/condition-900-analysis/MEASURED-REQUESTS.jsonl` — 6180891bytes; SHA256`8f9701dc3882f770f8bf20cbfc7f11c7d4768ff755ecc1d5cb3466d574b275f2`.
- `thesis/campaigns/worker-desktop-k3-orca-relayed-http-remaining-v1682/terminal-20261020T0213/RESULTS.md` — 4057bytes; SHA256`0d446a1b5c517e530c1de2d1e8e88793c8fba78393faa562dbd5405840336ab6`.
- `thesis/campaigns/worker-desktop-k3-orca-relayed-http-remaining-v1682/terminal-20261020T0213/native-analysis/SUMMARY.json` — 28833bytes; SHA256`977d2c08d27d73920fe981b533040814e81002bd7439f9d93ac2c0e4f5de9ba9`.
- `thesis/campaigns/worker-desktop-k3-orca-relayed-http-remaining-v1682/terminal-20261020T0213/resource-analysis/SUMMARY.json` — 6573bytes; SHA256`276060b4252e8eebae5d34eafb7f1733f923295c699c82fdc0d0ac7a2abf7548`.

Independent checks: K3-900-SINGLE-SAVED-DATA-REVIEW-CHECKS-20261020T0300.json and K3-900-SINGLE-SAVED-DATA-REVIEW-PROVENANCE-20261020T0302.json beside this report. GitNexus callable tools/context are unavailable in this session; direct named artifacts were used with the installed read-only analyze workflow. No repository-wide graph rebuild, additional reviewer, SUT call, private config read, audio replay or source mutation occurred. Root remains sole execution/source integrator and should continue first actual P2P K1 admission independently of this report. Monitor native goal remains active; this is not worker_done.
