# Results retained as of this audit

The retained results support several completed, bounded descriptive cohorts. They do not establish completion of the full13 objective, every product surface, or the expanded directed-pair matrix. This audit generated **zero new experimental measurements**. The single saved-data analysis finished successfully at 2026-10-17T22:23:27.742699+00:00; [its receipt](smoke/smoke-receipt.json) binds the exact entrypoint, counts and validation.

The final machine inventory is [cohort-inventory.json](cohort-inventory.json). It retains original author field names and reported aggregates separately from recomputed statistics, source references, settings/bindings, historical control results, missing fields and coverage gaps. Full precision remains in JSON; tables round only for display. **UNKNOWN means unresolved, never zero.**

## Cohort identity and allocation

| Cohort | Device / surface / mode | Audio identity | Effective backend / measured boundary |
|---|---|---|---|
| V491 | coding-worker ARM64, two logical CPUs; headless production Python; LocalBus | `139fa0c34b6d18600ad9608fd2d11c9389cae2f5f548ce0f4f23b735b176f0b3` | CPU LLM n_gpu_layers=0,n_threads=2; STT/Piper CPU; valid_non_silent_pcm16_tts_wav_received_decoded_and_checked_before_artifact_write |
| V737 | coding-worker ARM64, two logical CPUs; headless production Python; LocalBus | `da0ecc4ad0885746ab6e716585473917ab2b543a505bf0db09ebacfaa7943cbb` | CPU LLM n_gpu_layers=0,n_threads=2; STT/Piper CPU; valid_non_silent_pcm16_tts_wav_received_decoded_and_checked_before_artifact_write |
| V485 | Personal x86_64 / RX7600; headless production Python; LocalBus | `139fa0c34b6d18600ad9608fd2d11c9389cae2f5f548ce0f4f23b735b176f0b3` | LLM RX7600 Vulkan 25/25 observed offload; STT/Piper CPU; valid_non_silent_pcm16_tts_wav_received_decoded_and_checked_before_artifact_write |
| V497 | Personal x86_64 / RX7600; headless production Python; authenticated same-host loopback HTTP | `139fa0c34b6d18600ad9608fd2d11c9389cae2f5f548ce0f4f23b735b176f0b3` | LLM RX7600 Vulkan 25/25 observed offload; STT/Piper CPU; valid_non_silent_pcm16_tts_wav_received_decoded_and_checked_before_artifact_write |
| V735 | Personal x86_64 / RX7600; headless production Python; LocalBus | `da0ecc4ad0885746ab6e716585473917ab2b543a505bf0db09ebacfaa7943cbb` | LLM RX7600 Vulkan 25/25 observed offload; STT/Piper CPU; valid_non_silent_pcm16_tts_wav_received_decoded_and_checked_before_artifact_write |
| V745 | Personal x86_64 / RX7600; headless production Python; LocalBus | `da0ecc4ad0885746ab6e716585473917ab2b543a505bf0db09ebacfaa7943cbb` | LLM RX7600 Vulkan 25/25 observed offload; STT/Piper CPU; valid_non_silent_pcm16_tts_wav_received_decoded_and_checked_before_artifact_write |
| V779 | Personal x86_64 / RX7600; headless production Python; LocalBus segmented join | `da0ecc4ad0885746ab6e716585473917ab2b543a505bf0db09ebacfaa7943cbb` | LLM Vulkan 25/25; STT/Piper CPU; fixed WAV through validated TTS WAV |
| V692 | Personal x86_64 / RX7600; headless production Python; authenticated same-host loopback HTTP | `da0ecc4ad0885746ab6e716585473917ab2b543a505bf0db09ebacfaa7943cbb` | LLM RX7600 Vulkan 25/25 observed offload; STT/Piper CPU; valid_non_silent_pcm16_tts_wav_received_decoded_and_checked_before_artifact_write |
| V799 | Personal x86_64 / RX7600; browser normal UI / file-backed microphone; browser own UI path | `da0ecc4ad0885746ab6e716585473917ab2b543a505bf0db09ebacfaa7943cbb` | reported Python Qwen Vulkan; Whisper/Piper CPU; Node performance clock: recording, real STT, visible reply, TTS WAV and connected software playback completion |
| C06/V1068 | Personal x86_64 / RX7600; real Tauri app SDK file-audio compute; desktop local SDK | `da0ecc4ad0885746ab6e716585473917ab2b543a505bf0db09ebacfaa7943cbb` | warmup gate reports Qwen Vulkan25/25; Whisper/Piper CPU; SDK compute; renderer and native handler clocks remain separate |
| V1197 | coding-worker requester → Personal provider; headless Python distributed file-audio; ORCA-RELAYED authenticated HTTP | `da0ecc4ad0885746ab6e716585473917ab2b543a505bf0db09ebacfaa7943cbb` | requester STT/LLM CPU; provider Piper CPU; intermediary included; requester monotonic submitted WAV through validated remote generated WAV |

Historical model-weight identities, without reading or hashing model files in this audit: Qwen3.5-0.8B-Q4_0 `57d1997790d1744fba5b40a7317df71ea5e2acee28c47e78f0cce39c0703f8cf`; faster-whisper base `d01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9`; Piper en_US-ljspeech-medium `6f52a751e2349abe7a76735eb09dc1875298c77ea2342ffd2fef79ff81b87f22`. These are historical pinned identities rather than a new verification of installed weight files. The typed orbit task uses only Qwen; audio, STT and TTS are inapplicable there. CPU ARM64 and desktop x86_64/Vulkan settings/builds remain separate. Requested GPU-layer settings and actual offload are distinct fields in retained bindings and epoch declarations.

V491 is reconciled programmatically from its **original runner** (15 warmups,900 measured), frozen manifest (LocalBus, empty remote-stage set), progress,900 raw measured rows, summary and report. It is one headless CPU local condition. The separate V317 campaign ID `6ce98ae97d594d9fafcd1ff9ad4b9b1c` declares nine cells of100 measured plus5 warmups each. Index labels cannot exchange these populations. [Exact reconciliation and source hashes](smoke/v491-reconciliation.json).

| Cohort / condition | Planned | Attempted | Retained timing rows | Correct | Incorrect | Failure / interruption | Timeout | Extra warmups |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| V491 | 900 | 900 | 900 | 900 | 0 | 0 | 0 | 15 |
| V737 | 900 | 900 | 900 | 900 | 0 | 0 | 0 | 15 |
| V735 | 900 | 274 | 274 | 273 | 0 | 1 | 0 | 15 |
| V745 | 626 | 626 | 626 | 626 | 0 | 0 | 0 | 15 |
| V692 | 900 | 900 | 900 | 854 | 46 | 0 | 0 | 15 |
| V485 | 900 | 900 | 900 | 878 | 22 | 0 | 0 | 15 |
| V497 | 900 | 900 | 900 | 853 | 47 | 0 | 0 | 15 |
| V779 | 900 | 900 | 900 | 899 | 0 | 1 | 0 | 30 |
| V317-01-local-only | 100 | 100 | 100 | 100 | 0 | 0 | 0 | 5 |
| V317-02-api | 100 | 100 | 100 | 100 | 0 | 0 | 0 | 5 |
| V317-03-mesh | 100 | 100 | 100 | 100 | 0 | 0 | 0 | 5 |
| V317-04-api | 100 | 100 | 100 | 100 | 0 | 0 | 0 | 5 |
| V317-05-mesh | 100 | 100 | 100 | 100 | 0 | 0 | 0 | 5 |
| V317-06-local-only | 100 | 100 | 100 | 100 | 0 | 0 | 0 | 5 |
| V317-07-mesh | 100 | 100 | 100 | 100 | 0 | 0 | 0 | 5 |
| V317-08-local-only | 100 | 100 | 100 | 100 | 0 | 0 | 0 | 5 |
| V317-09-api | 100 | 100 | 100 | 100 | 0 | 0 | 0 | 5 |
| V426-local-only | 900 | 900 | 900 | 900 | 0 | 0 | 0 | 15 |
| V426-api | 900 | 900 | 900 | 900 | 0 | 0 | 0 | 15 |
| V799 | 900 | 900 | UNKNOWN | 889 | 11 | 0 | 0 | 15 |
| C06/V1068 | 900 | UNKNOWN | 4 | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |
| V1197 | 900 | 135 | 135 | 135 | 0 | 0 | 0 | 15 |
| V994 | 900 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| V1139 | 900 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| V734 | 900 | 0 | 0 | 0 | 0 | 0 | 0 | 15 |
| ANDROID-V448 | UNKNOWN | 0 | 0 | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |
| ANDROID-V1315 | UNKNOWN | 0 | 0 | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |
| MOBILE-BROWSER | UNKNOWN | UNKNOWN | 0 | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |
| ON-DEVICE-BROWSER | UNKNOWN | UNKNOWN | 0 | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |
| DESKTOP-REMOTE-CONSOLE | UNKNOWN | UNKNOWN | 0 | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |
| IOS | UNKNOWN | UNKNOWN | 0 | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |

For V799,900 is the surviving **reported** timing population, not newly recovered raw rows; raw-row count is UNKNOWN. C06 has four complete embedded measured-case observations; neither its final attempted population nor its final correctness/timeout distribution is known. Historical272 completed/273 attempted at2026-10-16T14:49:35.684913Z is a dated checkpoint, not a final denominator or lost-file count. For older control-only families, all unavailable counts are explicit in the machine inventory and source receipts below; source-check events are not counted as requests.

## Descriptive latency

Every displayed quantile uses Hyndman–Fan Type7, sorted zero-based position `(n-1)*p` with linear interpolation, units milliseconds. The primary table is **strictly correct measured requests**, with warmups excluded. No timed-out request is silently converted to a successful response. All completed/incorrect and observed/interrupted distributions remain separate in the machine inventory; the interrupted duration is an elapsed observation, not a completed response.

| Cohort / condition | Population n | p50 ms | p90 ms | p95 ms | Basis |
|---|---:|---:|---:|---:|---|
| V491 | 900 | 43,918.022 | 49,936.788 | 52,595.949 | recomputed saved raw/projection |
| V737 | 900 | 44,250.328 | 51,533.190 | 54,152.800 | recomputed saved raw/projection |
| V735 | 273 | 10,130.421 | 10,441.404 | 10,628.308 | recomputed saved raw/projection |
| V745 | 626 | 10,099.129 | 10,380.355 | 10,568.555 | recomputed saved raw/projection |
| V692 | 854 | 10,204.774 | 10,749.811 | 11,413.863 | recomputed saved raw/projection |
| V485 | 878 | 10,631.899 | 11,970.337 | 12,422.218 | recomputed saved raw/projection |
| V497 | 853 | 10,648.995 | 11,625.154 | 12,000.375 | recomputed saved raw/projection |
| V779 | 899 | 10,105.902 | 10,400.242 | 10,595.486 | recomputed saved raw/projection |
| V317-01-local-only | 100 | 30,492.343 | 34,627.555 | 36,737.924 | recomputed saved raw/projection |
| V317-02-api | 100 | 31,676.288 | 36,514.153 | 38,343.783 | recomputed saved raw/projection |
| V317-03-mesh | 100 | 34,570.500 | 40,538.200 | 41,758.750 | recomputed saved raw/projection |
| V317-04-api | 100 | 31,975.320 | 36,250.760 | 37,587.273 | recomputed saved raw/projection |
| V317-05-mesh | 100 | 35,104.500 | 41,006.000 | 42,095.350 | recomputed saved raw/projection |
| V317-06-local-only | 100 | 30,729.797 | 35,445.629 | 37,635.405 | recomputed saved raw/projection |
| V317-07-mesh | 100 | 34,441.000 | 40,997.400 | 42,202.450 | recomputed saved raw/projection |
| V317-08-local-only | 100 | 31,258.568 | 36,162.876 | 38,411.964 | recomputed saved raw/projection |
| V317-09-api | 100 | 31,349.794 | 34,907.352 | 36,138.770 | recomputed saved raw/projection |
| V426-local-only | 900 | 5,364.480 | 5,457.406 | 5,497.371 | recomputed saved raw/projection |
| V426-api | 900 | 5,381.306 | 5,582.345 | 5,849.052 | recomputed saved raw/projection |
| V1197 | 135 | 50,044.977 | 56,973.289 | 58,601.481 | recomputed saved raw/projection |
| V799 | 889 | UNKNOWN | 19,297.600 | 19,503.400 | author-reported retained aggregate; raw unlocated |

V485 retains22 strict incorrect answers; V497 retains47; V692 retains46; V799 retains11. Their original predicates and outcome labels remain unchanged. V735's one original interruption remains in V779:899 correct out of900 attempts. V745's626 cases are a new-ID compatible continuation of the original274, with15 additional warmups, not a new900-case result. V779 is a view of those same900 attempts and **must not be added** to its two source segments. Its restart/state/order/thermal limitations preclude a pure causal protocol-overhead interpretation. Correct-only and all-completed percentiles differ and remain named.

The finite V1197 snapshot is **INCOMPLETE**, captured at2026-10-17T22:15:24.539734+00:00:135 measured correct plus15 excluded warmups,765 measured still unattempted at that snapshot. Its descriptive partial quantiles do not seal900 or predict the final distribution. Later active progress is intentionally outside this frozen audit snapshot. The older `analysis-v1290` native analysis covers36 measured plus15 warmups using an older requester checkpoint; it is not another independent experiment or the denominator for current135 rows. Its joined provider coverage has36/36 spans rather than the stale24/36 prefix in `analysis-v1240`; the earlier twelve missing spans were a custody lag, not twelve model failures.

## Native service, model and caller populations

| Cohort | Host / stage / exact handler | n invocations | p50 ms | p90 ms | p95 ms |
|---|---|---:|---:|---:|---:|
| V735 | same original receiver host / llm / resolved_chat_model.astream | 274 | 262.674 | 275.751 | 289.194 |
| V735 | same original receiver host / stt / stt.model_invoke | 274 | 3,275.817 | 3,371.961 | 3,443.826 |
| V735 | same original receiver host / stt / Transcription.Transcribe | 274 | 3,279.749 | 3,382.591 | 3,469.793 |
| V735 | same original receiver host / tts / tts.model_invoke | 274 | 1,499.319 | 1,676.488 | 1,764.543 |
| V735 | same original receiver host / tts / TTS.Synthesize | 274 | 1,499.939 | 1,677.288 | 1,765.281 |
| V745 | same original receiver host / llm / resolved_chat_model.astream | 626 | 263.389 | 282.589 | 300.549 |
| V745 | same original receiver host / stt / stt.model_invoke | 626 | 3,254.847 | 3,357.006 | 3,425.978 |
| V745 | same original receiver host / stt / Transcription.Transcribe | 626 | 3,259.352 | 3,365.575 | 3,437.737 |
| V745 | same original receiver host / tts / tts.model_invoke | 626 | 1,492.733 | 1,667.709 | 1,753.432 |
| V745 | same original receiver host / tts / TTS.Synthesize | 626 | 1,493.515 | 1,668.483 | 1,754.136 |
| V692 | same original receiver host / llm / resolved_chat_model.astream | 900 | 265.981 | 303.401 | 396.764 |
| V692 | same original receiver host / stt / stt.model_invoke | 900 | 3,290.311 | 3,463.375 | 3,538.072 |
| V692 | same original receiver host / stt / Transcription.Transcribe | 900 | 3,297.194 | 3,473.882 | 3,558.533 |
| V692 | same original receiver host / tts / tts.model_invoke | 900 | 1,522.153 | 1,742.557 | 1,881.708 |
| V692 | same original receiver host / tts / TTS.Synthesize | 900 | 1,522.961 | 1,743.234 | 1,882.554 |
| V737 | same original receiver host / llm / resolved_chat_model.astream | 900 | 27,758.969 | 33,208.568 | 36,202.322 |
| V737 | same original receiver host / stt / stt.model_invoke | 900 | 7,979.215 | 10,509.267 | 11,317.553 |
| V737 | same original receiver host / stt / Transcription.Transcribe | 900 | 8,024.859 | 10,601.935 | 11,490.177 |
| V737 | same original receiver host / tts / tts.model_invoke | 900 | 2,583.460 | 3,960.458 | 4,607.341 |
| V737 | same original receiver host / tts / TTS.Synthesize | 900 | 2,584.094 | 3,961.022 | 4,607.933 |
| V1197_historical_analysis_v1290_36measured | requester / stt / stt.model_invoke | 36 | 8,010.958 | 9,740.435 | 10,565.735 |
| V1197_historical_analysis_v1290_36measured | requester / stt / Transcription.Transcribe | 36 | 8,016.220 | 9,747.360 | 10,577.513 |
| V1197_historical_analysis_v1290_36measured | requester / history / OrchestratorService._persist_chat_message | 72 | 23.578 | 39.700 | 47.962 |
| V1197_historical_analysis_v1290_36measured | requester / llm / resolved_chat_model.astream | 36 | 28,085.611 | 31,909.647 | 32,443.182 |
| V1197_historical_analysis_v1290_36measured | provider / tts / tts.model_invoke | 36 | 1,724.612 | 1,916.577 | 1,950.885 |
| V1197_historical_analysis_v1290_36measured | provider / tts / TTS.Synthesize | 36 | 1,725.271 | 1,917.357 | 1,951.937 |

These rows recompute retained derived exact-handler durations; raw pairing acceptance remains attributed to the original audited histories. The historical K1 rows independently check the saved endpoints within **each same-host span**. Caller-stage metrics are separately stored under each cohort's `recomputed.callerStages`; they are neither native invocation timings nor isolated network overhead. The historical K1 history handler has72 invocations for36 requests and is not a one-span-per-request population. Nested STT/TTS service/model spans overlap. Neither durations nor independent stage quantiles are added. No clocks from different hosts, Node/renderer and backend domains are subtracted.

V737's selected native subsets remain distinct from its prior global diagnostics:1830 invalid boundaries with unassigned cause. Valid exact-handler subsets do not imply all recorded boundaries are valid. Native attempt/operation/request/session IDs remain absent where originally absent. Queue waiting, TTFT, first streamed audio, physical acoustics and audibility remain UNKNOWN where not recorded.

## Previous controls, failed attempts and coverage

| Retained historical family | Result observations | Source / row custody |
|---|---|---|
| matched-readiness-v291-local-only | {"exit_code":0} | 9 source references; 1 row-source paths |
| matched-readiness-v292-api | {"exit_code":0} | 9 source references; 1 row-source paths |
| matched-readiness-v293-mesh | {"exit_code":1} | 9 source references; 1 row-source paths |
| matched-readiness-v296-mesh | {"n_total":2,"n_warmup":0}; {"exit_code":1} | 9 source references; 0 row-source paths |
| matched-readiness-v302-mesh | {"n_total":2,"n_warmup":0}; {"exit_code":1} | 9 source references; 0 row-source paths |
| matched-readiness-v307-mesh | {"n_warmup":0}; {"exit_code":1} | 9 source references; 0 row-source paths |
| matched-readiness-v310-mesh | {"n_warmup":0}; {"exit_code":1} | 9 source references; 0 row-source paths |
| matched-readiness-v313-mesh | {"n_warmup":0}; {"exit_code":1} | 8 source references; 0 row-source paths |
| matched-readiness-v315-mesh | {"n_warmup":0}; {"exit_code":0} | 10 source references; 0 row-source paths |
| mesh-build-enospc-v306-v307 | {"exit_code":1} | 9 source references; 0 row-source paths |
| mesh-consumer-refresh-v314-v315 | Source or control receipts retained; no qualified measured denominator inferred | 4 source references; 0 row-source paths |
| mesh-error-observer-typing-v300-v301 | {"exit_code":1} | 10 source references; 0 row-source paths |
| mesh-history-source-v280 | Source or control receipts retained; no qualified measured denominator inferred | 5 source references; 0 row-source paths |
| mesh-history-source-v280a | Source or control receipts retained; no qualified measured denominator inferred | 5 source references; 0 row-source paths |
| mesh-history-source-v280b | Source or control receipts retained; no qualified measured denominator inferred | 6 source references; 0 row-source paths |
| mesh-history-source-v280c | Source or control receipts retained; no qualified measured denominator inferred | 6 source references; 0 row-source paths |
| mesh-incomplete-main-v259 | {"exit_code":1} | 7 source references; 1 row-source paths |
| mesh-main-v261 | {"exit_code":1} | 8 source references; 1 row-source paths |
| mesh-main-v273 | {"exit_code":1} | 7 source references; 1 row-source paths |
| mesh-main-v281 | {"exit_code":0} | 10 source references; 1 row-source paths |
| mesh-refresh-generation-v312-v313 | Source or control receipts retained; no qualified measured denominator inferred | 9 source references; 0 row-source paths |
| mesh-second-call-source-v298-v300 | Source or control receipts retained; no qualified measured denominator inferred | 9 source references; 0 row-source paths |
| mesh-selection-v257-v258 | {"exit_code":1} | 7 source references; 1 row-source paths |
| mesh-source-checks-v254 | Source or control receipts retained; no qualified measured denominator inferred | 5 source references; 0 row-source paths |
| mesh-source-v272 | Source or control receipts retained; no qualified measured denominator inferred | 6 source references; 0 row-source paths |
| mesh-startup-v255-v256 | {"exit_code":1}; {"exit_code":0} | 8 source references; 1 row-source paths |

The26 families above retain their original result objects and any recorded failure classes/exit codes. Identical V319/exported-campaign projections are aliases of V317, not new cases. The three V317 mesh cells retain their requester `completion_kind` classifications (including the literal `fallback` state) and actual measured typed outcomes; no unobserved direct-network route or backend monotonic timestamp is invented.

V994 preserves its first excluded warmup failure at remote TTS transport after real local STT/LLM;0 measured of900 planned,1 failed warmup of15 planned. V803 is its status/preparation alias. V1139 is restoration/readiness,0 measured. V1194 stopped on a pre-start configuration-hash guard before requester/model invocation; that failure and the first finite health timeout before a later HTTP200 remain history, not measured samples. V734 retains15 successful excluded warmups followed by the Piper-path identity gate failure and0 measured; V737 does not erase it. Original audio readiness/collector failures and the separate V1060 normal native UI failure remain in source custody. None is evidence of poorer model accuracy merely because a harness, collector or transport failed.

Android V448 is the historical **Waydroid x86_64** APK/install/cold-launch observation with blank rendered UI and0 voice measurements. Its V445 screenshot/V446 failed inspection and build failures are retained in the original report; V448 also labels a separate web build and must not become Android runtime proof. V1315 is route documentation/preparation with0 new device actions; it does not establish current device callability or a completed900-case mobile condition. Mobile browser, on-device browser, desktop remote-console and other applicable non-iOS directed pairs remain unmeasured/UNKNOWN in scoped evidence. iOS is outside this execution scope and has no runtime evidence here. No emulator was started or contacted by this audit.

## Scientific interpretation and handoff

These are repeated requests on narrow fixed tasks and saved host sessions. The percentiles describe their named observed populations;900 serial requests do not by themselves establish independent task, user, device or acoustic generalization. Different audio, model/settings, CPU/GPU, surface, mode, session initialization and host load remain named conditions. Descriptive side-by-side reporting does not isolate protocol overhead or a causal acceleration effect.

Missing optional per-request proof audio/screenshots/logs does **not** universally invalidate retained measurements plus reproducible procedures. Missing full timing rows limits fresh percentile recomputation and joint/outlier/failure analyses; missing final C06 denominators specifically prevents a final C06 performance/correctness claim. [Missing-data-impact report](missing-data-impact.md) states the exact limits. Reproducible procedures cannot recreate historical unretained measurements; future reruns are new cohorts and no forced900 rerun is authorized.

Root retains the original goal, all active resource/process reservations and owner delivery. The original monitor alone writes methodology. This audit changes only its exclusive folder, makes no commits or publications, and leaves V1197 and all other owned sessions active.
