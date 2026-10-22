# Browser V799 post-terminal finalizer source preparation

This is an inert, one-shot finalizer for the existing browser V799 condition. It does not launch or signal workloads. Its CLI refuses by default; Root must explicitly pass `--execute-finalization`. Before creating an export or retirement receipt, it requires the exact frozen manifest `e67f8f98830ef0ceb978590bbe6b8b496ada2ad4ddd05bc34fb22248c65c10b8`, controller PID/start identity `3418365/74502600`, the controller and driver natural terminal receipts, and absence of the recorded web/backend/driver owners. It then acquires the existing global-build and desktop-GPU locks nonblocking, rechecks process absence, and writes a new exclusive retirement receipt. It never kills processes or removes locks.

The one archive is written only under `/tmp/aurora-root-padded-browser900-v799/export-v888/`. It retains the fixed input/frozen manifests, harness and hook sources, controller/runtime JSON/JSONL receipts, browser campaign event log, per-case outcomes, captured PCM and TTS WAV files, and resource/native-stage records. Private fixture/config/env files, runtime database/backups, and raw private service logs are omitted with bounded metadata. Original run data is not modified except for the new exclusive `runtime/retirement-v888.json`; the archive and audit sidecars are write-once.

The archive audit derives attempted, correct, incorrect, non-timeout failure, timeout, interrupted, and unattempted counts separately for 15 excluded warmups and 900 planned measured cases, then compares those counts to the driver terminal record. It calculates Type 7 p90/p95 only over measured `passed` full-flow cases, whose endpoint includes connected TTS playback completion. Native STT/LLM/TTS rows remain on their own Python process monotonic clock and are paired by exact case/span/correlation identity; handler metrics have separate denominators and are never summed. Missing or multiple spans remain explicit. Queue, TTFT, streamed-first-audio, physical microphone/acoustic capture, and physical speaker output remain unknown.

Future Root invocation after terminal/retirement admission:

```text
python3 /home/developer/projects/aurora/.git/aurora-handoff-import-20261006/browser-post-terminal-prep-v888/post_terminal.py --execute-finalization
```

This script was not run. Only Python AST parsing is intended here. It does not copy the archive to the nearly-full project filesystem. Any later transfer to worker custody requires a fresh actual destination-capacity observation proving free bytes cover the actual archive size plus the existing 80,000,000-byte reserve. No benchmark result, successful full-flow count, or publication is claimed by this source preparation.


## V896 exact-owner gate closure

Original Root preserved V888 and fixed the sole V893 owner-gate batch in this new copy. The actual spawn startTicks must match original controller74502600; every recorded owned process identity is validated and its PID is included in both the pre-lock and post-lock fresh absence checks, including browser descendants. No process is signalled and no lock is removed. Existing terminal-only opt-in/denominator/Type7/native-clock/archive behavior is unchanged. AST-only source parsing passed; no audit, candidate import, runtime or workload was executed. The retirement-v888/export-v888 names remain the original unused one-shot V799 destinations and refuse existing output.
