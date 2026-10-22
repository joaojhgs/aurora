# Desktop speech readiness: retained failures and component observations

These are excluded readiness cases, not accepted measurement samples. The four
original logical flows all failed. There are **zero accepted speech samples**
in this closed block, and no speech p90/p95 estimate is supported. The separate
typed CPU and GPU campaigns remain distinct cohorts.

| Case | Observed result | Main stages reached |
| --- | --- | --- |
| 1, V427 | Product locale `en-us` was rejected by Whisper | Session creation; STT failed |
| 2, V428 | STT completed after the locale/sample-rate fix; transcription predicate failed | Session creation; STT |
| 3, V429 | Actual STT output continued; pilot used an incompatible session type | Session creation; STT; Assistant rejected the session |
| 4, V431 | Correct session; real model ran; recognized command and answer were incorrect | Session creation; STT; Assistant/LLM |
| Case 4 output continuation, V432 | Real synthesis, browser software playback and saved history completed; parent task stayed failed | Existing history; Piper; AudioContext `onended`; history readback |

The fixed synthetic instruction was “Reply with exactly this single word and
no punctuation: ORBIT.” Tiny Whisper instead produced “apply with exactly this
single word and no punctuation. Or bit.” The Assistant answered “I am ready to
apply the requested tool.” The actual recognized input was preserved and used
downstream; it was never replaced with the reference instruction.

The output continuation used that saved answer without repeating STT or LLM.
It is not a fifth full flow and cannot be joined across the diagnostic gap into
a continuous end-to-end latency. Real Piper synthesis took 1609.8 ms; browser
software playback took 2414.1 ms, with 100352 decoded frames at 44100 Hz
(2.27555556 seconds). Piper's source rate was 22050 Hz. Software completion does
not establish microphone capture, acoustic audibility or production React UI.

The continuation's raw `output_bytes=0` is preserved. `decodeAudioData` detached
the ArrayBuffer before that field was read; the original byte count is therefore
unavailable, rather than evidence of empty audio. No cosmetic replay was run.

Each JSON file is a byte-preserved compact observation received from the actual
desktop run. Its process-presence fields describe its observation timestamp,
not current liveness. Both original voice runtimes subsequently retired. The
corrected runtime exited 0 at 21:53:33.108701 UTC, and its runtime/controller PIDs
were absent at 21:54:10.510312 UTC on 2026-10-14.

The later V434 check has a different purpose: admit newly integrated correlation
and stage capture. Its result is recorded separately and does not rewrite these
failures or admit a 900-sample task condition. Full individual speech/surface
acceptance and the CPU+GPU barrier remain unfinished. No cross-device measured
traffic is released by this report.
