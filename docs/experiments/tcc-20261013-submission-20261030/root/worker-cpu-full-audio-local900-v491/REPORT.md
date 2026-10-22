# Worker CPU full-audio comparison — 2026-10-15

**Status: Current bounded check.** The original frozen V491 campaign finished naturally at 15:21:29.783085 UTC: **900/900 measured correct**, zero incorrect, failed, timed-out or unattempted cases. All 15 additional warmups were correct and are excluded from percentiles. This is the separate extraCPU cohort, `aurora-full-audio-capital-v1-worker-cpu-local-20261015`; it is not pooled with desktop GPU results.

The production Python LocalBus path ran real fixed audio → faster-whisper STT → Qwen Assistant → Piper TTS → decoded, valid non-silent PCM WAV. The reference was “What is the capital of France? Answer with only the city name.” Correctness required the exact normalized reference word sequence, the single reply word “Paris,” and matching request/session/correlation identifiers. No transcript, answer, model or predicate was changed during the campaign.

| Measured boundary | Samples | Type 7 p90 ms | Type 7 p95 ms |
| --- | ---: | ---: | ---: |
| Full flow through checked audio | 900 | 49936.7875221 | 52595.9486264 |
| STT caller stage | 900 | 10630.5304123 | 11274.44997995 |
| Assistant caller stage | 900 | 37560.8704425 | 40089.5693048 |
| TTS caller stage | 900 | 3928.0318947 | 4677.26998075 |

Type 7 linearly interpolates sorted samples at zero-based position `(n - 1) * p`. Full-flow and correct-only denominators are both 900 here. Stage quantiles are independent and must not be added. Raw per-case durations, outcomes, correlated stage records and resource history are retained. Queue delay, first token, first streamed audio, UI capture, playback and physical audibility are not established by this headless caller boundary.

Hardware was the coding worker's two logical ARM64 CPUs, with Qwen Q4_0 at zero GPU layers/two threads, faster-whisper base CPU `int8_float32`/beam5/VAD, and Piper LJSpeech medium CPU. The frozen manifest records the exact weights, decoding/constructor settings, CPU backend readiness observations, versions, hardware, source hashes and host-specific differences from desktop Vulkan. Its embedded readiness PID and original V490 harness provenance are historical; the actual V491 launch/terminal records bind controller 2232517 and Python 2232566. The controller's terminal CPU-log projection is empty; this report does not substitute it for the recorded readiness/backend provenance.

The unmodified campaign ran from 04:00:53.581864 to 15:21:29.783085 UTC. At 15:22:40.833212 UTC both exact PIDs were absent and the local global-build lock was available, then released. No process was terminated. Free project storage was 10,260,238,336 bytes. This releases the worker campaign's resources; it does not release the personal desktop's unrelated V641 reservation.

Root invoked the previously approved collector once, then performed one saved-ZIP/member/raw/outcome/audio-reference/Type7 reconciliation. All 915 output-audio references matched their retained byte counts and hashes; decoding was performed by the original campaign, not repeated by the archive verifier. The archive retains every raw attempt and output, frozen input/setup, 13 pinned production files, actual and historical non-secret harnesses, versions, stages, resource history, launch, terminal and retirement. Eight credential-bearing/private omissions are recorded by path/reason and available size/hash; model weights are referenced rather than copied.

- [Raw archive](aurora-worker-cpu-full-audio-local900-v491.zip): 33,027,484 bytes, 1,865 members including its manifest; SHA-256 `83b9084a09abfe641968b2958e210ed589dbcd655f0a9a26c18f2bc4dd80d897`.
- Archive manifest SHA-256: `cfcec63729d52a8c59a03efdae52a1ea7cee8bdb9403e662dcac8295f8ea9165`.
- Frozen campaign manifest SHA-256: `364832a627e2f45b4b1c2b80ca05739f809132a28ff26511f0eda5e30f89127a`.
- Original WAV: 153,644 bytes, 76,800 mono PCM16 frames at 22,050 Hz; SHA-256 `139fa0c34b6d18600ad9608fd2d11c9389cae2f5f548ce0f4f23b735b176f0b3`.
- [Verification report](verification-v652.json): SHA-256 `ec94a94cfe8e7ee4de65a59cfe7990fd02eac94c33c91370c17d5da7ffb77478`.

This result accepts only the frozen original headless CPU comparison. The new padded UI-audio candidate remains unqualified, individual product surfaces remain unfinished, and measured cross-device traffic remains held. See the [current results index](../CURRENT.md).
