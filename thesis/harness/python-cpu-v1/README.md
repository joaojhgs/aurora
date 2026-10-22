# Manual Linux CPU condition

**Status: Partial feature.** The manual setup, launcher and six harness sources are present and source-reviewed. Full positive setup and runtime validation of this portable adapter remain open. Existing measured campaigns use their frozen sources; these files have not been substituted into them.

Use Python 3.11 on an admitted, idle Linux host with the existing Aurora build/measurement reservation available. The adapter consumes an existing environment, the exact seven model/config files in the [weight lock](../../models/weight-lock-v1.json), the [qualified fixed input](../../fixtures/capital-padded-v1/fixture.json), and the [400-file production source](../../source/README.md). It installs or downloads nothing. Package versions alone do not establish native-library/build equivalence; [model and native-build provenance](../../models/README.md) remains incomplete.

Prepare the production source as described in its linked README. Supply an existing Python virtual environment with the six backend versions in the [semantic profile](../../profiles/padded-capital-v1.json) and the remaining Aurora dependencies required by that source. Use that environment's `bin/python` path, preserving its virtual-environment identity. Supply the existing isolated test configuration containing `services.auth.api_keys` and `services.gateway.api.token_secret`; preparation copies only those existing values into private run data. Keep configuration contents and private backend logs out of public reports.

From the repository root, substitute actual existing paths in this manual example. Choose a fresh run directory for each attempt:

```bash
uv run --no-sync python thesis/setup_cpu.py \
  --source /path/to/prepared-production-source \
  --python /path/to/existing-venv/bin/python \
  --stt-dir /path/to/faster-whisper-base-snapshot \
  --llm /path/to/Qwen3.5-0.8B-Q4_0.gguf \
  --tts /path/to/en_US-ljspeech-medium.onnx \
  --tts-config /path/to/en_US-ljspeech-medium.onnx.json \
  --piper /path/to/existing-piper-venv/bin/piper \
  --fixture-config /path/to/existing-isolated-config.json \
  --run-dir thesis/runs/cpu-padded-001
```

The command requires Linux/Python 3.11 and acquires `/tmp/aurora-global-build.lock` before environment inspection, model reads or run-directory writes. It verifies the source lock, model sizes/hashes, fixture/reference, backend versions and executable availability. It writes a fresh private run directory, copies the six harness sources and fixed input, records environment/hardware declarations, and freezes `measurement-admission.json` plus `PREPARED.json`. This prepares data only; it does not load models, start services or admit physical resource isolation. The ignored `thesis/runs/` directory is not an evidence-publication location.

If the existing environment requires them, append `--library-dir /path/to/existing/native-libraries` (repeatable) and/or `--nltk-data /path/to/existing/nltk-data`. `--attempt-id` supplies a distinct attempt label; otherwise setup creates one from its preparation timestamp. These arguments select existing resources and do not install or modify them.

After preparation succeeds and Root admits the physical resources and condition, launch explicitly:

```bash
uv run --no-sync python thesis/launch_cpu.py \
  --run-dir thesis/runs/cpu-padded-001 --execute-measurements
```

This starts the real CPU workload: 15 additional excluded warmups, then 900 measured full audio requests. Normal warmups must establish actual STT/LLM/TTS providers, correlated native stages, strict transcript/answer correctness and valid output audio before measured request 1. The CPU LLM uses zero GPU layers and two LLM threads; native thread pools are reported separately. Limits remain 180 seconds per request, 57,600 seconds per condition and 57,840 seconds for the controller. The controller rechecks the frozen inputs and owns its one backend plus bounded cleanup. An occupied reservation, changed pins or existing runtime refuses a new launch; preserve the failed attempt and prepare a fresh directory rather than deleting or reusing it.

Read `runtime/campaign/progress.json` for actual progress and `runtime/terminal.json` plus `runtime/campaign/summary.json` for terminal outcomes. Process startup is not measurement completion. Preserve attempted incorrect, failed, interrupted and timeout cases, additional excluded warmups, unattempted counts, per-case history and resource/native-stage records. Do not pool CPU/GPU, changed-input or incompatible settings cohorts. This adapter measures the production headless LocalBus flow; it supplies no browser, microphone, playback, mobile or cross-device acceptance.

The [original five-source custody record](SOURCE-CUSTODY-v747.json) preserves the retained origin hashes; the [new manual adapter record](SOURCE-CUSTODY-v756.json) adds the controller/setup/launcher and source review. Three actual [model-free admission checks](../../validation/manual-cpu-admission-v753.json) verified reservation refusal and default opt-in refusals. The earlier [runner/bootstrap guard checks](../../validation/default-execution-guard-v747.json) are retained. These finite checks and source approval do not claim that full positive setup, a fresh environment or a new 900-case runtime has passed. No campaign is part of module import, default tests or CI.
