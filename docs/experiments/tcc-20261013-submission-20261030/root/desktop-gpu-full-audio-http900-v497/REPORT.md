# Desktop GPU authenticated HTTP full-audio condition V497

Natural terminal: 2026-10-15 10:18:07 UTC. This same-host authenticated loopback HTTP condition is sealed with qualified task correctness, not an all-pass product result.

| Outcome | Measured | Excluded warmups |
| --- | ---: | ---: |
| Correct | 853 | 15 |
| Strict incorrect | 47 | 0 |
| Execution failure/interruption | 0 | 0 |
| Timeout | 0 | 0 |
| Attempted | 900 | 15 |
| Unattempted measured | 0 | — |

All 47 incorrect results, total-attempt ordinals 869–915, returned “The capital of France is Paris.” rather than only “Paris”. Their normalized reference transcripts and request/session/correlation checks passed. The exact reply predicate remains unchanged and every incorrect result is retained.

Type 7 uses sorted samples, position `(n − 1) × p`, with linear interpolation between adjacent samples. All 900 completed measured flows, including incorrect outcomes: p90 **11637.4428838 ms**, p95 **12029.8744915 ms**. The separate correct-only 853 subset has p90 11625.1542258 ms and p95 12000.3750672 ms. Excluded warmups never enter these percentiles.

| Caller stage | Measured samples | p90 ms | p95 ms |
| --- | ---: | ---: | ---: |
| STT | 900 | 3732.9782218 | 3996.04842335 |
| Assistant | 900 | 6245.155023 | 6617.53652625 |
| TTS | 900 | 1757.9350856 | 2182.43624225 |

Stage percentiles are independent and cannot be summed. Queue, first token, first streamed audio, playback and physical audibility remain unknown. These caller timings do not isolate Gateway overhead or establish causal route effects.

The frozen WAV, model weights, six package versions and effective inference settings match the separate desktop local condition; the condition-specific frozen manifest is `886d2fade5b14da2fccf272d272c6164479a86e81371ad1afdb738b7d0de1eea`. Actual LLM execution used RX7600 Vulkan acceleration with 25/25 layers offloaded; STT and TTS ran on CPU. The cohorts remain separate, with no CPU/GPU pooling or repetition to improve outcomes.

Root observed the original controller 2968233 and Python 2968234 absent and both global/GPU locks free at 10:19:10 UTC; no process was terminated. Child exit1 reflects strict incorrect outcomes. The controller retains stale launch fields `measurementStarted=false` and `measuredRequests=0`; preserve them as launch metadata. The saved raw attempts, summary and progress establish the 900 measured/15 warmup denominator.

Root invoked the approved collector once, then performed one offline saved-ZIP/member-hash/raw-row/summary/progress/audio-reference/Type7 verification. All 915 output-audio references match inventory. Sol approved bounded report/receipt consistency, without independently accessing the remote ZIP. The archive secret scan passed; credential-bearing configs, environment and raw backend logs remain declared omissions.

The raw ZIP remains in project docs on **personal.skyron-server**, at the path and checksum recorded in [EVIDENCE-LOCATION.json](EVIDENCE-LOCATION.json). It has not been copied to coding-worker. The byte-exact [verification-v563.json](verification-v563.json) is available here. This does not establish UI/native voice, physical microphone or playback acceptance, full individual AUDIO+SURFACE completion, cross-device admission or aggregate story completion. No model, predicate or existing campaign input was changed, and no repeat900 is justified by this seal.
