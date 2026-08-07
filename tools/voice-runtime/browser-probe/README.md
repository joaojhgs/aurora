# Phase 4 Browser Voice Probe

This harness serves the pinned sherpa-onnx VAD+ASR and KWS Emscripten artifacts
with COOP/COEP headers and runs them inside dedicated browser Workers. It does
not vendor WASM, `.data`, model, or generated run artifacts.

Example:

```bash
AURORA_VOICE_P4_ARTIFACT_ROOT=/path/to/p4-native-voice \
  uv run python tools/voice-runtime/browser-probe/run_phase4_browser_probe.py \
  --browser chromium \
  --report-json /path/to/browser-probe.json
```

The probe loads the combined `wasm-vad-asr` module, creates a Silero VAD and an
offline Moonshine recognizer from the embedded package files, runs the pinned
Moonshine test WAV inside a Worker, and records main-thread timer lag from the
page. It then runs KWS in a second Worker with the selected GigaSpeech data
archive. The workers run sequentially to bound peak memory, and a browser result
passes only when VAD, ASR, KWS, worker scope, cross-origin isolation, and
`SharedArrayBuffer` checks all pass.
