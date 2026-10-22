# K3: worker to Personal desktop, actual P2P, all three voice stages

The declared condition reached **900 measured attempts: 773 correct complete-audio flows and 127 failures**. No measured request was retried. Collection, requester custody and the saved-data analysis are complete. This result does not mean900successful flows or whole-matrix/product acceptance.

| Outcome | Measured count |
|---|---:|
| Correct full audio | 773 |
| Preaccept capability rejection | 71 |
| Assistant answer failed the strict correctness predicate | 55 |
| Historical ambiguous STT request timeout | 1 |
| Unattempted | 0 |

All35warmup attempts are excluded:30correct and5failed. ParentV1988 retains global1–276 (256correct/20failed); V2043 contains only277–900 (517correct/107failed). The parent timeout at276 was not retried. The source/audio/model/settings and each immutable manifest remain separately retained; only prospective count/index/session/reporting changes joined these same-effective epochs.

## Latency populations

All values below are milliseconds; p50/p90/p95 use Hyndman–Fan type7 linear interpolation. The primary complete-flow population is the773correct returned-audio outcomes. Time-to-outcome for failed/partial flows is a separate population and must not be presented as complete-audio latency.

| Population | n | p50 ms | p90 ms | p95 ms |
|---|---:|---:|---:|---:|
| Correct complete audio | 773 | 12482.775340 | 13919.323346 | 14665.765187 |
| All attempts, time to outcome | 900 | 12381.121251 | 13778.362977 | 14558.635789 |
| Failed attempts, time to outcome | 127 | 4569.831089 | 11008.217275 | 11754.386395 |

## Stages and resource evidence

STT, LLM and TTS ran on the original Personal desktop receiver251473/start29038457. The worker requested each stage through the production Gateway Mesh/PeerBridge. The frozen setup uses the same local model weights and decoding settings; the native admission recorded Vulkan25/25LLMlayers on the8GBRX7600, STTCPU/int8_float32 and PiperCPU. Native times use desktop monotonic clocks. Requester stage times use worker monotonic clocks and include caller/route/wait/handler work. No cross-host timestamp subtraction or pure protocol-overhead claim is made.

| Stage | Correct-flow n | Native p90 ms | Native p95 ms | Requester p90 ms | Requester p95 ms |
|---|---:|---:|---:|---:|---:|
| stt | 773 | 3513.505578 | 3571.714799 | 5593.914730 | 6126.518354 |
| assistant | 773 | 344.721494 | 786.599314 | 5966.657927 | 6432.782736 |
| tts | 773 | 1842.848421 | 1923.225392 | 3024.531628 | 3358.811752 |

The935retained cases (900measured+35warmups) join to **2530 native span pairs**, caller routes/call boundaries and per-host resource brackets. The analysis reports **0 gaps**. The provider snapshot contains4272nativepairs across all historical scopes; extra warmup/preflight rows are excluded by correlation. The provider has13826identity-matched resource samples; requester parent/current have3700/7721. GPU vendor counter reads report errors (96782provider/3700parent/7721current field entries); retain those errors, never replace missing readings with zero. Actual GPU acceleration is supported separately by native constructor/layer proof. Per-case resource records are in case-analysis.jsonl.

Before/after selected-pair observations are retained. They do not supply a pair identifier or prove continuous direct/relay purity. The historical timeout had a completed remote native STT span and a changed requester peer-connection instance; its exact reply failure cause remainsUNKNOWN. Native completion does not prove requester delivery or transcript correctness for that failed call.

## Correctness limitation

The55assistant-answer failures begin at global844 and remain failed partial flows. Their transcripts met the reference predicate, while assistant replies did not meet the required answer predicate; TTS was not promoted into a successful full-audio result. The exact cause remainsUNKNOWN. A response hash alone is not evidence of a model, runtime, harness or transport root cause. No predicate was weakened and no settings were changed during this frozen run.

## Durable custody and reproduction

Both requester histories are physically retained in this repository: parent293cases/271WAV/17577980indexedpayloadbytes and current642cases/532WAV/34988875indexedpayloadbytes. The saved pass verified all2940indexedfiles and803actualWAVs. The original provider files remain in the Personal repository thesis/; a fixed-prefix archive is physically present and verified on both hosts:15files/72756019rawbytes,4611284archivebytes, SHA256462847fd5b22695873aee2fae763025012f9abf08ad888fb2bb67e6cc09c4559. Resources were still sampled after measurement, so this is explicitly a fixed-prefix snapshot, not final provider retirement/EOF.

- Machine summary: [RESULT.json](RESULT.json)
- Correlated raw-derived rows: [case-analysis.jsonl](case-analysis.jsonl)
- Provider custody: [CUSTODY.json](../provider-prefix-transfer-v2129/CUSTODY.json)
- Actual native goal snapshot: [NATIVE-GOAL-CLOSURE-v2132.json](../NATIVE-GOAL-CLOSURE-v2132.json)

Reproduce from the repo root into a new output directory:

```sh
python3 thesis/harness/analyze_k3_mesh_saved_v2130.py --out /path/to/new-output-directory
```

The entrypoint uses retained evidence only. Its shared saved-data resource/quantile helper is pinned in RESULT.json. No SUT imports, inference, network traffic or historical-row overwrite occurs.

## Next finite condition

Under ownerplan§30.72, the preferred next cell is K1actualP2P ONLY191new measured/global710–900, retaining709priorattempts/12failures. K1Orca-relayedHTTP ONLY720/global181–900 is the admissible alternative if the actual P2P runtime cannot pass ordinary finite admission. Both are currentlyNOT_ADMITTED; provider/reservation/source/runtime/capacity and localSTT+LLM/remoteTTS admission remain execution work. No phone gate, closed-cohort replay, new worker, review loop or whole13completion follows from this condition closure.
