# Production speech timing admission: two excluded cases

Both cases use the real production `uv run --active --no-sync python main.py`,
the existing HTTP SDK, pinned models/settings and the same fixed synthetic WAV.
They are logical readiness flows 5 and 6, following the four retained failures
in [the preceding block](../desktop-voice-readiness-v434/README.md). Neither is
an accepted measurement sample. No speech p90/p95 or full-surface acceptance
follows from these cases.

Flow 5 recorded 17 server events with complete capture and zero recorder errors.
Its newly appended browser wrapper was not selected: assigning to an existing
export getter silently retained the older function. The actual STT and Assistant
calls therefore stopped at the old answer predicate. This harness failure is
retained; it is not a missing TTS implementation.

Flow 6 replaced the namespace object and asserted wrapper identity before any
API call. All software stages completed in 11497.1 ms: session creation, STT,
real Assistant/LLM, real Piper synthesis, browser AudioContext playback and
persisted history readback. STT and answer predicates remained false, with the
same actual recognized input and answer as before. The result is
`instrumentation_flow_completed_task_failed`, with zero accepted measurements.

| Flow 6 stage | Browser duration, ms | Actual server provider invocation, ms |
| --- | ---: | ---: |
| STT | 859.7 | 817.111925 |
| Assistant | 6615.0 | 432.798148 |
| TTS synthesis | 1575.6 | 1480.374911 |
| Browser software playback | 2379.7 | unavailable |
| Saved history readback | 40.1 | separate persistence spans retained |

Browser and server have distinct clock domains. Differences between whole
request duration and provider spans are unclassified; they are not measured
queue wait, network overhead or pure protocol cost. Actual server persistence
spans and IDs are in `span-analysis.json`. Queue, first-audio, physical capture
and acoustic completion remain unavailable. Software playback is not physical
audibility or production React UI acceptance.

The server observer captured 23 events (18624 bytes), with complete capture and
zero write, flush or rejection errors. STT and TTS service/model boundaries have
matching operation/attempt and server-envelope IDs; the actual LLM and history
spans share their Assistant server-envelope ID. Uncorrelated startup TTS records
remain uncorrelated.

The SDK header-to-server join **did not pass**. Its generated result facade
discarded transport metadata. STT/TTS results returned no correlation audit;
Assistant's returned audit used its caller/body correlation instead of the
different server-envelope correlation. The raw flow-6 `server_correlation_id`
field on the Assistant stage is therefore mislabeled caller data, not a server
header observation. Raw files remain unchanged, with this explicit correction.

The owning SDK repair preserves transport audit through generated validation
and retains the old path for custom peer requesters. Its focused eight-test file
and package typecheck passed, and independent source review approved the final
source SHA-256 `696fc4fa11d095655718da263951d3a4c1aa69c5bbfe67d4b1b1ae01d867f3b7`.
That later source fix was not part of these recorded executions and does not
retroactively establish their missing header join. No seventh diagnostic flow
was run.

Both runtimes exited 0 after their pilots finished. Flow 6's runtime finished at
22:08:16.802171 UTC on 2026-10-14; its pilot, runtime, instrumented Python and
controller PIDs were all absent at 22:08:17.024185 UTC. Original desktop records,
archive transfers and source versions remain retained. The first large result
line was clipped by the relay; paced frame transfer recovered the existing
archive without replaying model work.

These cases do not seal the full individual GPU speech/surface campaign. The
CPU+GPU barrier remains closed to cross-device measured traffic. The earlier
typed CPU/GPU cohorts remain separate and unchanged.
