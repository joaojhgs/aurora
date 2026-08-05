# Local Speech Benchmarks

This directory contains non-production benchmark harnesses for Aurora local
speech engine selection. The Phase 0 STT lane is intentionally isolated from
production packages and lockfiles: it uses Python standard-library code plus
externally supplied engine commands, so benchmark-only dependencies do not leak
into release builds.

## Scope

- `common/` owns versioned result loading, scoring, aggregation, redaction, and
  `result.schema.json`.
- `stt/` owns candidate metadata, STT adapters, CLI runner, and focused tests.
- `stt/fixture_manifest.schema.json` describes approved fixture manifests.
- `tests/fixtures/local_speech/stt/` owns approved fixture metadata. Reports may
  include fixture IDs and aggregate metrics only; raw audio, paths, transcripts,
  command output, credentials, and private device identifiers are rejected.

The current Aurora server STT contract accepts complete base64 audio through
`Transcription.Transcribe`, defaults to 16 kHz mono PCM/WAV-style inputs, uses a
fixed language when configured, and otherwise allows auto detection. This
harness mirrors those fixed versus auto language modes for browser/mobile
candidate evaluation.

## Candidate Matrix

The initial STT bake-off tracks the approved plan candidates:

| Candidate ID | Role | Upstream source | Current harness status |
| --- | --- | --- | --- |
| `transformersjs-whisper-webgpu-wasm` | Compatibility baseline/fallback, measured `.en` variant | <https://huggingface.co/Xenova/whisper-tiny.en> | External adapter required; English fixed-language coverage only until a multilingual artifact is pinned |
| `transformersjs-moonshine-onnx` | Short-form latency candidate | <https://huggingface.co/onnx-community/moonshine-tiny-ONNX> | External adapter required |
| `sherpa-onnx-wasm-streaming` | Streaming/mobile candidate | <https://k2-fsa.github.io/sherpa/onnx/wasm/index.html> | External adapter required |
| `whisper-cpp-wasm` | Portability fallback | <https://github.com/ggml-org/whisper.cpp> | External adapter required |
| `fixture-smoke` | Harness smoke only | local fixture manifest | Deterministic offline smoke |

Exact engine revisions, immutable model revisions, package versions, downloaded
model hashes, browser feature probes, and device details are recorded in
benchmark result JSON. Values left as `TBD-*` in `stt/candidates.json` are
decision inputs that must be filled by the integration owner or a device/browser
benchmark runner before release.

## Running

Deterministic offline smoke:

```bash
uv run python benchmarks/local-speech/stt/run_benchmark.py \
  --candidate fixture-smoke \
  --run-id local-stt-smoke
```

Unavailable-candidate smoke without installing any benchmark engine:

```bash
uv run python benchmarks/local-speech/stt/run_benchmark.py \
  --candidate whisper-cpp-wasm \
  --external-command definitely-missing-aurora-stt-adapter
```

Real engine adapters should be supplied as an external JSON command:

```bash
uv run python benchmarks/local-speech/stt/run_benchmark.py \
  --candidate transformersjs-whisper-webgpu-wasm \
  --external-command node path/to/private/adapter.mjs
```

The command receives `--candidate-id`, `--fixture-id`, `--audio`, and
`--language`. Successful runs must print one JSON object containing `text` and
may include
`finalization_latency_ms`, `initialization_ms`, `download_bytes`,
`peak_memory_mb`, `thermal_state`, `browser_features`, and
`runtime_provenance`. Selection-quality rows should also include
`utterance_count`, `latency_statistic` (`p95` for pre-aggregated p95 rows),
`evidence_kind`, `target_surface`, and `device_profile`. Non-ok runs may print
`status` plus `failure_bucket`; the harness preserves those states without
fabricating metrics. Runtime provenance is a whitelisted, redacted map for
candidate ID, immutable model revision/hash set, package pins, runtime package
versions, and browser/runtime name only. Paths, model paths, host/user/device
IDs, serials, tokens, secrets, and local artifact paths are rejected. The
harness never copies stdout, stderr, audio paths, reference transcripts, or
hypotheses into reports.

Local `artifacts/` and `reports/` directories are ignored. Use them for
downloaded models, private fixture manifests with local audio paths, and
redacted run outputs.

## Decision Rule Inputs

The section 16 STT gate requires WER by language/noise bucket, fixed and auto
language modes, finalization latency, initialization, download bytes, peak
memory, thermal state, browser/WebView feature support, runtime provenance, and
failure buckets across English and Portuguese, clean and noise buckets, and
desktop browser plus Android and iOS WebView target surfaces. A new mobile
default must meet the target p95 end-of-utterance latency for each required
surface with no required bucket regressing by more than two absolute WER points
and no memory or thermal failure.

This harness records those inputs; it does not make the final product decision
from fixture-smoke, one clean English sample, all-failed runs, missing
Portuguese/noise/device evidence, unsupported auto mode, or missing thermal
evidence.

Decision summaries are generated from redacted reports:

```bash
uv run python benchmarks/local-speech/stt/decision_gate.py \
  --baseline-report benchmarks/local-speech/reports/<run>/whisper.redacted.json \
  --candidate-report benchmarks/local-speech/reports/<run>/candidate.redacted.json \
  --baseline-id transformersjs-whisper-webgpu-wasm \
  --candidate-id transformersjs-moonshine-onnx \
  --output benchmarks/local-speech/reports/<run>/decision.redacted.json
```

If fixed/auto language modes, latency, WER, memory, thermal, browser/WebView, or
device evidence is missing, the output remains `decision_blocked` and the CLI
exits `2` after writing the redacted decision report.
