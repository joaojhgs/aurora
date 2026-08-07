# Sherpa C API Phase 4 Probes

This directory contains a small, reproducible probe harness for sherpa-onnx
v1.13.4 C API semantics. It intentionally does not vendor sherpa, onnxruntime,
or model files.

The runner compiles `phase4_sherpa_probe.c` against an existing sherpa C API
install and runs the same binary in five modes:

- `stt`: Moonshine offline recognizer
- `vad`: Silero VAD compatibility
- `kws`: keyword spotting stream
- `tts`: VITS/Piper offline TTS
- `tts_cancel`: VITS/Piper TTS cancellation through a progress callback that
  returns `0`

Example:

```bash
python tools/voice-runtime/c-api-probes/run_phase4_c_api_probes.py \
  --artifact-root /path/to/p4-native-voice \
  --result-json /path/to/c-api-probe-results.json
```

The artifact root is expected to contain:

- `builds/linux-x86_64/install/include`
- `builds/linux-x86_64/install/lib`
- `models/extracted/sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27`
- `models/extracted/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01`
- `models/extracted/vits-piper-en_US-ljspeech-medium`
- `models/silero-vad-v4.0.onnx`

The original GigaSpeech KWS package is the selected Phase 4 probe input. The
smaller `-mobile` package currently aborts the native ORT stream with a reshape
error and must stay unavailable until a separate exact-pack gate passes.

By default the VAD and KWS probes use the KWS package's bundled 16 kHz wavs.
Override the exact wavs by editing the runner arguments or invoking the
compiled probe directly with `--vad-wav` and `--kws-wav`.

Use `--install-dir`, `--models-dir`, or `--silero-model` to override those
locations.
