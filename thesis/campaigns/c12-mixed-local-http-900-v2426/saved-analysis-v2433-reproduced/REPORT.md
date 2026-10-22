# C12 saved-data snapshot

POINT_IN_TIME_PARTIAL_NOT900_COMPLETE

Cutoff: 2026-10-22T08:01:39.739752+00:00; 23 complete paired capsules.

| Stream | Measured outcomes /900 | Correct | Failed | Timeout flags | Correct-only p90 ms | p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| HTTP | 22 | 22 | 0 | 0 | 31502.6595264 | 31822.1531275 |
| local | 22 | 22 | 0 | 0 | 14743.969201 | 14835.6022773 |

HF7 linear interpolation, milliseconds. Every percentile denominator is explicit in SUMMARY.json. Samples condition on correct full audio; failed/timeout outcomes remain in the attempt population. Stream/epoch/warmup distributions are separate. Partial small-sample quantiles are descriptive, not a final900 tail claim.

Full-case duration includes fixed input read/start-record persistence, actual STT/LLM/TTS, strict correctness/valid-audio validation and WAV persistence; pipeline duration is separately retained from composition. Copy/control after completion is separate and influences reported inter-arrival/rate windows.

Provider queue/native comparisons share one provider monotonic clock. Enqueue-to-model bounds include dispatch and pre-model processing; no pure queue/network/protocol-overhead claim. Resource/network counters are aggregate, not per-request attribution.

Positive-flow native/queue gaps: 0. No new inference or network traffic was generated.
