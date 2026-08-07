# Phase 6 Native Resource Metrics

This wrapper measures selected native voice candidates with `/usr/bin/time -v`
and writes a redacted JSON report. It is diagnostics-only: Linux and emulator
runs always report `physical_device_claim: false`, and generated reports stay
under ignored artifact paths.

## Scope

- `vad` runs the existing Rust `vad_parity_driver` example.
- `kws` runs the targeted native KWS smoke test.
- `stt` runs the targeted native Moonshine STT smoke test.
- Reports include only bounded task/candidate IDs, surface/arch labels,
  aggregate wall/CPU/RSS/RTF metrics, failure buckets, repetition counts, and
  `thermal_state: unavailable_in_linux_ci`.
- Reports never include command lines, model paths, WAV paths, transcripts,
  environment variables, stdout, stderr, user names, or native pointers.

## Example

```bash
uv run python tools/voice-runtime/resource-metrics/run_phase6_native_resources.py \
  --artifact-root /path/to/p4-native-voice \
  --task vad \
  --repetitions 1 \
  --output .artifacts/voice-runtime/resource-metrics/native-vad.json
```

The artifact root is expected to contain the Phase 4 native voice layout:

- `builds/linux-x86_64/install/lib`
- `models/silero-vad-v4.0.onnx`
- `models/extracted/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01`
- `models/extracted/sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27`

`--physical-device-claim true` is rejected. Physical-device certification
requires a separate device harness and must not be inferred from this report.
