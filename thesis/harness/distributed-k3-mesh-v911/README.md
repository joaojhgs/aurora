# V903 cumulative K3 exact-peer mesh source candidate

This is an unlaunched, source-only candidate for K3: the code-worker sends the
fixed file audio through the production typed MeshBus methods
`Transcription.Transcribe`, `Orchestrator.ExternalUserInput`, then
`TTS.Synthesize`, each to its own Root-admitted existing peer session. The
K3 HTTP composition and its exact full-transcript, exact Paris, non-silent
mono PCM WAV, partial-quality accounting, 15 excluded warmups, 900 measured
requests, 180-second request cap, and 57,600-second condition cap are retained.
The HTTP adapter and HTTP credentials are not used. No local or other-peer
fallback, retry, or service-method call is accepted as remote mesh work.

The candidate uses the separate actual `accurate` route label and the frozen
Faster-Whisper constructor-directory/member identity (model, config, tokenizer,
and vocabulary). LLM constructor arguments are checked against frozen
effective settings and receiver V430 constructor-return records. The assistant
async span keeps its real span ID while operation/attempt IDs remain null per
the existing V430 contract. TTS requires its actual operation and attempt IDs
and Piper model/config binding. Configured settings do not establish actual
hardware acceleration; Root must supply any separate actual GPU execution
receipt required for that receiver.

## Warmup barrier

`receiver_proof.py` is an offline assembler. It requires 15 correct complete
flows, 45 distinct remote native stage spans, 45 exact-peer calls represented
by 90 start/end boundary rows, and 45 same-call nominated-route snapshots
before measured request 1. Requester case IDs, remote correlation IDs, native
span IDs, receiver PIDs, and route observer process clocks remain distinct
fields. No cross-process monotonic subtraction is performed. Snapshot evidence
is before/after across peer-connection ICE transports; it does not establish
pair identity or continuous route stability. The sink allows 2,761 rows (2,745
planned stage calls plus 16 setup rows), at most 32 KiB per row and 64 MiB
total. Missing, ambiguous, lossy, unsuccessful, or quota-exceeding evidence
blocks measured request 1.

## Root admission still required

`freeze-template.json` and `route_runtime_pins.json` are intentionally
non-launchable. Root must independently bind the three existing authorized
peer sessions, receiver source/config/provider identities, STT constructor
directory and its four pinned members, exact Assistant settings, actual
runtime `.pth`/aiortc/aioice files, complete source equivalence, models,
resources, locks, retirement, and all 45 real warmup receiver/route joins.
The route observation source/runtime versions and hardware route are not
accepted from a configured peer ID alone. Actual GPU execution remains a
separate receiver admission item; this source candidate does not convert an
`n_gpu_layers` setting into acceleration evidence.

No code was imported or executed and no service, model, network, device, build,
or test was run. This candidate is not a result or acceptance claim.
