# K2 V1904 saved-data/source review — CLOSED

Outcome: no material count, join, unit or scope error found in the requested bounded review. This closes this review slice; it does not establish full-matrix completion or authorize a replay.

- Original Run: run_e6054e76e9fc; monitor Task task_d7ea336050cf; Dispatch ctx_37b4d0a3c14f.
- Request: Root msg_3c042e1f4684, 2026-10-20T20:43:20Z; ACK delivery_b65a70f0f60b.
- Reviewer: existing monitor, GPT-6.1-Sol/xhigh; no child agent/model/account change.
- Source: thesis/harness/analyze_k2_mesh_saved_v1904.py, 22,722 bytes, SHA256 aefa658239e4e8fab1e4690a6e6156448314f60e4d5c377defe7b0cf49748ed4.
- Packet: thesis/campaigns/worker-desktop-k2-p2p-assistant-tts-v1826/analysis-v1904/.
- No SUT commands, tests, inference, analysis rerun, remote control command or full raw custody re-audit.

## Evidence inspected

Read the complete 316-line source, REPORT.md and SUMMARY.json once. Read INPUTS/OUTPUTS and verify all five indexed output size/hash pairs, including the generated case/native JSONL. Perform one bounded pass over these derived rows for counts/unique joins/finite positive native durations, nonnegative bracket slack/CPU/network deltas and resource RSS presence. Inspect three representative measured cases: 1 correct, 174 TTS preaccept rejection, 786 assistant reply-format rejection. No additional sample matrix.

Pinned files:

| File | Bytes | SHA256 |
| --- | ---: | --- |
| thesis/harness/analyze_k2_mesh_saved_v1904.py | 22722 | aefa658239e4e8fab1e4690a6e6156448314f60e4d5c377defe7b0cf49748ed4 |
| thesis/campaigns/worker-desktop-k2-p2p-assistant-tts-v1826/analysis-v1904/SUMMARY.json | 7150 | 797a2347c7e3a72936a595720c710dc14f091498ddfbac12bde4d26a7ff2c222 |
| thesis/campaigns/worker-desktop-k2-p2p-assistant-tts-v1826/analysis-v1904/REPORT.md | 3234 | 12e63fc238755199e05f1534f6bcd2494fa312411536888c5e2ca24d16490c84 |
| thesis/campaigns/worker-desktop-k2-p2p-assistant-tts-v1826/analysis-v1904/INPUTS.json | 453665 | 25bd87f9e1abcca695517adb720e69b13aa8516522ca2335e5016f9e75382a72 |
| thesis/campaigns/worker-desktop-k2-p2p-assistant-tts-v1826/analysis-v1904/OUTPUTS.json | 1082 | 7739d47b0a07d07c7a8567ee56b1e8031b414e1328c1e9814adc98cfcc0c2f5f |

## Findings and scope

1. Counts and failure denominators reconcile: 15 correct excluded warmups; measured indices exactly 1–900 with unique correlations; 774 correct plus126failed (115 strict reply-format and11preaccept). Zero timeouts/unattempted are retained in the requester seal. No success top-up or silent exclusion.
2. Current native pairs total2619: 45warmup plus900STT/900LLM/774TTS measured. Every derived stage/correlation pair is unique. Source validates same PID/handler/span/correlation; assistant request/session and STT/TTS operation/attempt pairs; actual LLM constructor settings and Piper invocation pairing. Earlier30provider correlation/stage pairs remain excluded. All1715current remote call/route joins, including warmups and rejected TTS calls, reconcile.
3. Representative case1 contains all3native stages and successful assistant/TTS routes. Case174 has actual STT/LLM and failed TTS call/route without native TTS. Case786 has actual STT/LLM, assistant route success but failed reply predicate, and no TTS invocation. Their distinct missing-TTS reasons remain preserved.
4. HF7 interpolation uses (n−1)p with linear interpolation; monotonic nanoseconds are converted to milliseconds by1e6. Correct full-audio n774p90=19429.4432782ms/p95=20761.114956149995ms matches the already sealed requester result. All900quantiles explicitly include partial/failed attempts. Native all-invoked STT/LLM distributions use900each; nativeTTS uses774. Correct-only native subsets are separately labelled.
5. Cross-host monotonic subtraction is not performed. ICE evidence is before/after selected nominated snapshots, with no continuous-stability or pure-network-overhead claim. Native versus requester intervals remain distinct.
6. Resource joins use same-host process/start-tick-selected sample streams. Maximum endpoint slack is1513.026308ms. CPU deltas include slack; process CPU excludes Piper subprocess CPU. RSS is KiB; GPU/network counters are host/device context, not exclusive request cost. No overlapping-bracket summation is claimed. All2619derived native records have nonzero sampled RSS; no negative CPU/network deltas or invalid native durations were observed. Missing-counter counts are retained in SUMMARY.json.
7. Frozen model/audio/constructor and readiness GPU references remain explicit. STT/Piper remain CPU; actual Vulkan proof applies to LLM readiness. Fixed-file audio is not physical microphone/playback evidence, and this packet does not close Android, concurrency, other pairs or the wider matrix.
8. Receiver rejection/output-change causes remain UNKNOWN. No causal GPU/model/network diagnosis or unlike-cohort pooling is introduced.

## Next action and stop condition

Review slice CLOSED. Root remains sole execution/source owner. Proceed with the already identified finite K3 candidate focused batch/admission, preserving K1remaining191 and every outstanding full-matrix condition. Do not add a new readiness/review matrix or repeat closed900conditions on account of this review.

Limit: this was a bounded source/derived-data review with three necessary representative outcomes and existing validated custody receipts, not an independent reparse/hash of every raw provider member or verification of all planned study metrics. Important raw inputs and generated outputs remain physically under thesis/; no data were moved or deleted.
