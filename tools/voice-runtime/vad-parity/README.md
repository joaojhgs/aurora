# VAD Parity Harness

This tool compares the pinned sherpa-onnx v1.13.4 Silero VAD behavior between:

- native Rust through `aurora-voice-sherpa-sys`
- Chromium worker + `SharedArrayBuffer` + cross-origin isolation
- Firefox worker + `SharedArrayBuffer` + cross-origin isolation
- WebKit worker + `SharedArrayBuffer` + cross-origin isolation

It is VAD-only. It does not claim a physical device and writes reports only under the ignored `.artifacts/` tree.

## Inputs

The runner expects the Phase 4 artifact root:

```bash
export AURORA_VOICE_P4_ARTIFACT_ROOT=/path/to/p4-artifacts
```

Required browser artifacts under that root:

- `builds/wasm-vad-asr/bin/sherpa-onnx-wasm-main-vad-asr.js`
- `builds/wasm-vad-asr/bin/sherpa-onnx-wasm-main-vad-asr.wasm`
- `builds/wasm-vad-asr/bin/sherpa-onnx-wasm-main-vad-asr.data`
- `sources/extracted/sherpa-onnx-1.13.4/wasm/vad-asr/sherpa-onnx-vad.js`
- `models/extracted/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01/test_wavs/0.wav`

The native run also needs the pinned Silero model file and sherpa C API library. The runner searches the artifact root for:

- `models/silero-vad-v4.0.onnx`
- `sources/extracted/sherpa-onnx-1.13.4/wasm/vad-asr/assets/silero_vad.onnx`
- `sources/extracted/sherpa-onnx-1.13.4/wasm/vad/assets/silero_vad.onnx`
- `libsherpa-onnx-c-api.{so,dylib,a}` or `sherpa-onnx-c-api.lib`

The runner verifies exact pinned input hashes before execution:

- Silero model: `a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28`
- KWS `test_wavs/0.wav`: `6bc58a4efdf20daac252b6b1502632601a71efe0308f6757dc1eda34891a7e4f`

Override when needed:

```bash
export AURORA_SHERPA_ONNX_MODEL=/path/to/silero_vad.onnx
export AURORA_SHERPA_ONNX_LIB_DIR=/path/to/sherpa/lib
export AURORA_SHERPA_ONNX_TEST_WAV=/path/to/test_wavs/0.wav
```

## Run

```bash
python tools/voice-runtime/vad-parity/run_vad_parity.py
```

Optional browser subset:

```bash
python tools/voice-runtime/vad-parity/run_vad_parity.py --browser chromium
```

Reports are written to `.artifacts/voice-runtime/vad-parity/<timestamp>/report.json`.

## Validation Rules

- WAV input must be RIFF PCM16 mono 16 kHz.
- PCM16 conversion divides by `32768.0`.
- VAD config is exactly threshold `0.25`, min silence `0.25s`, min speech `0.25s`, max speech `10s`, window `512`, sample rate `16000`, one channel, provider `cpu`, buffer `30s`.
- Cases: full flush, reset replay, discontinuity reset with no stale state, second flush idempotence, reset-during-feed cancellation equivalent, and `31s` continuous silence rolling-buffer operation.
- Native and browser feeds drain completed segments after every accepted 512-sample window or terminal tail, then flush and drain the final tail.
- Canonical fixture output is exactly `{start: 5728, length: 93696}` for full flush before browser/native tolerance comparison.
- Browser workers must run with `SharedArrayBuffer` and `crossOriginIsolated`.
- Segment count/order must match native. Segment start and length may differ by at most `512` samples.
- Per-window accept p95 must be `<32ms`; reports label accept timing separately from per-chunk/final drain timing.
- `--skip-native`, `--skip-browsers`, or a browser subset produces partial diagnostics and cannot return top-level `ok: true`.
- `physical_device_claim` is always `false`.

## Tests

```bash
python tools/voice-runtime/vad-parity/test_vad_parity_runner.py
```
