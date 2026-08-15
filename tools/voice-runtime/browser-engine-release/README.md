# Browser Engine Release

This lane stages the neutral Sherpa browser runtime as engine code only:
VAD+STT, KWS, and TTS JavaScript/WASM/helper files. It uses the pinned
`sherpa-onnx-source-v1.13.5` entry from `tools/voice-runtime/phase4_manifest.json`
for source identity and writes release outputs under ignored artifact paths.

It deliberately refuses model and voice payloads. `.data`, ONNX/ORT files,
tokenizers, WAVs, archives, and other model-like files are not valid release
outputs. Voice and language model packs stay catalog-driven and are downloaded
on demand by product code after a user chooses them.

Example staging from existing neutral artifacts:

```bash
python tools/voice-runtime/browser-engine-release/stage_browser_engine_release.py \
  --artifact-root /home/developer/projects/aurora/.artifacts/pockettts/p4-native-voice \
  --source-root /home/developer/projects/aurora/.artifacts/sherpa-onnx-1.13.4-neutral-20260814053955 \
  --tts-artifact-root /home/developer/projects/aurora/.artifacts/sherpa-onnx-1.13.4-neutral-tts-wasm-202608140712 \
  --output-root /home/developer/projects/aurora/.artifacts/voice-runtime/browser-engine-release/current
```

The output contains:

- `assets/vad-stt/*` for VAD and ASR engine code.
- `assets/kws/*` for keyword spotting engine code.
- `assets/tts/*` for TTS engine code.
- `reports/browser-engine-release.provenance.json` and `reports/SHA256SUMS`.

Use `--download-source` to fetch the pinned Sherpa source archive when the Phase
4 evidence root does not already contain it. Use `--build` only in an
Emscripten-enabled shell; if `emcmake` is not on `PATH`, the build step reports
that external tool gap instead of pretending to produce fresh WASM.
