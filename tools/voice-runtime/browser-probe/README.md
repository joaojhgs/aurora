# Phase 4 Browser Voice Probe

This harness serves the pinned sherpa-onnx VAD+ASR Emscripten artifacts with
COOP/COEP headers and runs them inside a dedicated browser Worker. It does not
vendor WASM, `.data`, model, or generated run artifacts.

Example:

```bash
AURORA_VOICE_P4_ARTIFACT_ROOT=/path/to/p4-native-voice \
  uv run python tools/voice-runtime/browser-probe/run_phase4_browser_probe.py \
  --browser chromium \
  --report-json /path/to/browser-probe.json
```

The probe loads the combined `wasm-vad-asr` module, creates a Silero VAD and an
offline Moonshine recognizer from the embedded package files, runs the pinned
Moonshine test WAV inside the Worker, and records main-thread timer lag from the
page.
