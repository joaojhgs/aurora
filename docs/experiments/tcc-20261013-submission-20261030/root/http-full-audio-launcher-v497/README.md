# V497 private authenticated-HTTP full-audio control

This directory prepares future source wiring only. It adapts the reviewed V485 controller/bootstrap lifecycle to the unchanged reviewed V493 `runner.py` (SHA-256 `43cc4f3152f1675e14641fedcc30a4071f1185ce8ae7edfd211271bc0fbffd51`); it does not alter the runner's correctness predicate, endpoint sequence, request limits, denominators, model, or HTTP behavior. No campaign was launched from this candidate.

## Fixed condition bounds

- One retained Supervisor and one same-process authenticated loopback Gateway HTTP condition.
- 15 excluded warmups followed by 900 measured requests.
- 180 seconds per request, 12,600 seconds per condition, 12,780 seconds outer controller cap.
- Existing exclusive desktop-GPU reservation lock and global build lock.
- Same desktop GPU cohort admission: before launch, require AMD PCI device `0x7480` with `8,573,157,376` bytes VRAM, record the detected GPU identity, and pass `GGML_VK_VISIBLE_DEVICES=1`, `OMP_NUM_THREADS=2`, `OPENBLAS_NUM_THREADS=2`, and `MKL_NUM_THREADS=2` to the child. This preserves the effective V485 GPU/thread setup; actual backend/offload evidence remains a later result requirement.
- Startup floor: 100 MB free in the private campaign volume, 250 MB free in `/dev/shm`, and 2.5 GB available host memory. During execution, one-second resource samples include host memory/disk, process stat/RSS, host and child network namespace counters, and the existing GPU counters.
- Only the launched child process group is signaled during owned cleanup. Private launch, terminal, backend log, resource, runner, voice-stage, and pilot outputs remain under `runtime/` with restrictive process umask.

## Required Root-prepared inputs

Root must create these exact paths after the V485 condition ends and the HTTP condition is independently admitted:

- `source/`: immutable application source snapshot.
- `env/`: already provisioned Python environment with `bin/python`.
- `hook/bindings.py`, `hook/observer.py`, and `hook/aurora_voice_telemetry_v430.py`; all three must be exact-path, byte-size, and SHA-256 entries in `harnessFiles`.
- `input/pilot-input.json`: exact three-key runner input (`wavSHA256`, `referenceTranscript`, `expectedReplyWords`).
- `input/frozen-http-manifest.json`: hash-addressed frozen manifest. The launcher requires the independent SHA-256 in `AURORA_HTTP_V497_EXPECTED_FROZEN_SHA256` to match before parsing or trusting it. It must contain the V485 pin sections (`sourceFiles`, `harnessFiles`, `audio.inputOriginal`, `models.stt.weightFiles`, `models.llm.weights` plus `actualConstructor`, `models.tts.weights`, `voiceConfig`, `executable`, and `runtimeVersions.packages`), an exact `pythonEnvironment` binding, and a `launchConfig` object with the absolute `input/launch-config.json` path, byte size, and SHA-256. Harness pins must name the exact V493 runner, this candidate's controller/bootstrap/bindings, and both observer files. The model/source/harness/audio entries each carry absolute path, bytes, and SHA-256.
- `pythonEnvironment`: Root's independently admitted shared desktop Python environment. It contains `venvPath`, `interpreterPath` (exactly `<venvPath>/bin/python`), `resolvedInterpreterPath`, and `resolvedInterpreterSHA256`. The resolved executable must be a regular non-symlink file whose current bytes match the pinned hash. A normal uv/venv `bin/python` symlink is accepted only when its resolved target exactly matches that binding. The environment stays at the admitted shared path; it is neither copied nor modified. Bootstrap separately verifies the six frozen package versions.
- `input/launch-config.json`: already frozen private launch config with the existing authenticated Gateway fixture, HTTP server enabled on `127.0.0.1` or `localhost`, and timeout at least 180 seconds. The controller checks its path, size, and hash and never writes it. It creates a fresh mode-0600 `runtime/config.json` byte-for-byte from this input and points normal startup at that copy, so ConfigManager startup normalization cannot mutate the frozen input. V493 continues to perform its ordinary before/after and drift checks against the runtime copy.
- The existing gateway fixture environment must supply exactly one of `AURORA_HOSTED_PEER_GATEWAY_API_KEY` / `AURORA_HOSTED_THIN_GATEWAY_API_KEY`, or both with equal values. The controller passes the existing value through without printing or storing it; no key is generated, copied, or seeded.
- Existing models and original WAV referenced by the frozen manifest must remain at their exact paths and match declared hashes/sizes. The controller reads and verifies them; it never copies them or follows symlinks.

The concrete deployment map is shared between coding-worker preparation and the personal desktop launcher: `ROOT=/home/developer/projects/aurora/.git/aurora-handoff-import-20261006/http-full-audio-v497`, `RUNNER=/home/developer/projects/aurora/.git/aurora-handoff-import-20261006/http-full-audio-v493/runner.py`. These same paths must exist on the desktop before launch; a different transfer location is not supported by these fixed scripts. Campaign-owned input/source/hook/output paths must remain inside this exact private root and non-symlinked. The admitted shared Python environment is the sole explicit exception to private-root containment and is accepted only through the four frozen `pythonEnvironment` fields above; the interpreter link is checked against its exact resolved target and hash. Source files must be under `source/`. Pinned immutable model assets may be elsewhere only when individually declared and verified by the frozen manifest. The controller creates a new `runtime/` exactly once and fails closed on a preexisting path. It does not synthesize launch config, create symlinks, or mutate source/input files.

## Verification performed by the future wrapper

Before launching, the controller checks the externally admitted frozen-manifest SHA before parsing, root containment and symlinks, the explicit shared-environment/resolved-interpreter binding, frozen input/config identity, every pinned source/harness/model/audio size and SHA-256, exact LLM constructor settings, existing authenticated loopback HTTP config and timeout, availability of the already provisioned fixture key, free port, and startup resource floor. Bootstrap installs the copied bindings and observer and requires all six package versions to equal the frozen manifest before dispatching to the fixed V493 runner. V493 itself retains authenticated health readiness, config-drift and fixture-key checks, per-stage HTTP requests/correlations, task correctness, TTS audio validation, warmup exclusion, measured denominators, and shutdown conditions.

The wrapper retains no API key in its receipts. Runtime logs are private and may contain application diagnostics; only Root's authorized collector should handle them. Do not export raw backend logs as public evidence.

## Status and limits

The rich manifest, independent expected frozen SHA environment binding, three-key input, launch config, source snapshot, shared-environment admission, hook copy, and existing gateway-key environment binding are intentionally unprovided placeholders here; no automatic provisioning is performed. Any missing, mismatched, symlinked, or unadmitted input stops before the runner launches. This candidate has not been executed, imported, built, or tested. It does not establish an HTTP result or a cross-surface comparison. Root owns post-seal preparation, source review, launch admission, and execution.
