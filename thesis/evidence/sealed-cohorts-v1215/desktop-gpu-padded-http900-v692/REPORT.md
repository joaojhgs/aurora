# Desktop padded-audio HTTP condition V692

**Status: Current bounded check.** The original condition finished naturally at 2026-10-15 21:19:38.110691 UTC. The original controller 3116872 and backend 3116892 were absent at 21:21:39 UTC. One retirement/export/saved-archive outcome audit completed; durable worker archive transfer is in progress. This is same-host authenticated loopback HTTP performance, with the original full thirteen-story goal still open.

## Outcomes and end-to-end latency

| Population | Correct | Incorrect | Execution failures | Timeouts | Unattempted |
| --- | --- | --- | --- | --- | --- |
| 900 measured requests | 854 | 46 | 0 | 0 | 0 |
| 15 additional excluded warmups | 15 | 0 | 0 | 0 | 0 |

The runner exited 1 with `completed_with_failures_or_incorrect`. Incorrect results remain incorrect; their cause is not inferred from the status label. All 915 output WAVs were checked in the single saved-result audit. No retry or extra attempt replaced a failed predicate.

| End-to-end population | n | Type 7 p90 ms | Type 7 p95 ms |
| --- | --- | --- | --- |
| All completed measured requests, including incorrect answers | 900 | 10779.086541 | 11515.7969795 |
| Correct-only measured requests | 854 | 10749.8105892 | 11413.8626138 |

Type 7 uses sorted position `(n - 1) * p` and linear interpolation. Warmups are excluded. The boundary is submitted fixed audio through validated generated WAV; it excludes physical capture and playback. These populations are separate and are not pooled with original-audio, CPU or other modes.

## Actual stage spans

The original conservative audit found two STT and two TTS span types per case and left an unqualified single-span aggregate null. A separate saved-data analysis groups the exact handler identities. Every group below has **900/900 measured cases**, zero missing, duplicate-within-handler or invalid-clock boundaries, and includes incorrect answers. Service and invocation spans remain separate; no times or percentiles are added.

| Exact observed handler | Type 7 p90 ms | Type 7 p95 ms |
| --- | --- | --- |
| `stt.model_invoke` | 3463.3750054 | 3538.07191285 |
| `Transcription.Transcribe` | 3473.8818394 | 3558.532779 |
| `resolved_chat_model.astream` | 303.4011624 | 396.76407415 |
| `tts.model_invoke` | 1742.556882 | 1881.70846575 |
| `TTS.Synthesize` | 1743.2337898 | 1882.55398295 |

The [versioned metrics](NATIVE-SPAN-METRICS-v733.json) and [per-case handler durations](native-span-durations-v733.csv) derive from the exact saved [native case history](NATIVE-STAGE-CASE-HISTORY.json), SHA-256 `cc4aead5d0650ee8ae667e509b72bf01d6adbdf80de962cb47a1311ecb601158`. Durations retain the audited same-process clock/PID/span pairing. The portable [analysis source](../../../../../thesis/analysis/native_span_metrics.py) launches no workload and does not replay the archive/outcome audit.

Native operation/attempt IDs exist for STT/TTS invocation spans; they remain absent for the LLM and service wrappers, with counts in the metrics. Request/case correlation is retained independently. Queue delay, first token, streamed first audio and playback remain null with reasons. These measurements do not establish pure protocol overhead, synchronized cross-host clocks, physical audibility, an unloaded host or isolated per-route network usage.

## Frozen setup and custody

Frozen manifest SHA-256 is `81c25bd59323b1d515d20f9ea154868640e0f0d55b04cb39e77e88fb414aa78f`. The exact padded input SHA-256 is `da0ecc4ad0885746ab6e716585473917ab2b543a505bf0db09ebacfaa7943cbb`; model/settings/input qualification is retained in the [qualified setup](../ui-full-audio-readiness-v675/qualified-manifest.json). Actual acceleration is RX7600 Vulkan 25/25 LLM layers; faster-whisper and Piper run on CPU. No backend/settings/source/count changed during measurement.

The single saved ZIP contains 1,857 members, 34,691,761 bytes, SHA-256 `7f1438bd700d5a794a879f5a38d7293275acf4d827289a50c6c49e01dc1a1870`. It remains under `/tmp/aurora-root-padded-http900-v692/export-v715/` on `personal.skyron-server`, with all original raw files preserved. Desktop project publication correctly failed its actual-size-plus-80-MB reserve admission. Worker transfer uses the existing approved Orca control and exact byte/hash verification; [custody location](EVIDENCE-LOCATION.json) distinguishes saved remote custody from a completed worker copy. No cleanup, access change or repeated outcome audit occurred.

The copied [archive manifest](ARCHIVE-MANIFEST.json) and original [audit verification](audit-verification.json) preserve the original frozen identities. The first file-transfer response exceeded terminal output retention; its receipt and zero-byte partial were preserved. The same immutable-file transfer continues in smaller chunks. This transfer limitation is separate from the completed measurement.

## Next boundary

After exact saved-copy custody and fresh resource/lock admission, execute the already source-approved matching desktop LocalBus condition. The new matching padded worker CPU cohort requires exact source/input/environment admission and its planned warmup gate; the original CPU cohort used different audio and remains historical extraCPU. The [performance transition checklist](../performance-transition-v732/REPORT.md) applies the owner's performance-only gate: microphone/playback/Android rendering issues block their affected cells and do not form a blanket distributed-performance barrier. Applicable surface coverage, cumulative remote stages and the full aggregate objective remain open.
