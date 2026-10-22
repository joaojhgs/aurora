# K1 HTTP — full 900-request outcome closure

Closed 2026-10-22T05:56:06.735600+00:00. The condition has 900 measured attempts: 899 correct, one preserved failure, zero incorrect answers and zero timeouts. All condition indices1–900 and all900 recorded case IDs are unique.45 warmups are excluded.

Latency statistics stay separate for the three frozen process/source epochs. Values below are seconds; each percentile uses correct requests only, with its denominator shown.

| Epoch | Global indices | Attempted | Correct | Failed | Percentile n | p50 s | p90 s | p95 s |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| V1197 | 1–180 | 180 | 179 | 1 | 179 | 50.323 | 57.463 | 60.305 |
| V2234 | 181–450 | 270 | 270 | 0 | 270 | 50.957 | 58.608 | 60.103 |
| V2296 | 451–900 | 450 | 450 | 0 | 450 | 55.696 | 63.355 | 64.784 |

Estimator: Hyndman–Fan Type7, h=(n−1)p with linear interpolation. V1197 figures retain the original saved aggregate; V2234 and V2296 figures come from their saved-raw-data analyzers. There is no pooled900-request latency percentile.

The preserved failure is global index180, case audio-campaign-v802-0195: remote_transport_error during TTS, with timeout=false. It was not retried.

The final450 epoch has450 actual STT,450 LLM and450 TTS native stage joins;1395 joins include its15 excluded warmups, with no positive-flow native gaps. Its465 cases/audio files and both nodes’ raw stages/resources are retained.

The provider prefix archive (6,871,434 bytes) and final EOF delta (670,362 bytes) are checksum-verified. The resource prefix plus delta reproduces the124,438,276-byte provider resource EOF exactly. Both original desktop SUT processes and all original requester/copier/collector processes retired. The condition’s process allocation is released; Root keeps scheduling ownership for the remaining objective.

The finalization transfer failure is preserved: one terminal frame was absent, its exact fragment was recovered from the unchanged retained archive, and smaller copy pages completed custody. No inference or provider export was replayed.

Machine-readable outcomes and source hashes: [FULL900-SUMMARY.json](FULL900-SUMMARY.json), [MEASURED-ID-INDEX.jsonl](MEASURED-ID-INDEX.jsonl), [RESOURCE-RELEASE.json](RESOURCE-RELEASE.json).

The original full13 goal and the remaining accepted matrix remain open. Owner notification is pending delivery through the original monitor/Coding route.
