# Voice runtime tools

Sherpa PocketTTS work in this tree is bounded to the native/WASM Sherpa path.
Do not modify the Python PocketTTS provider, model loader, or inference.

## Patch queue

Aurora stages official sherpa-onnx `v1.13.5` and applies
`tools/voice-runtime/sherpa-patches/`. See that README for hashes, rebase, and
the PocketTTS-only boundary.

```bash
python tools/voice-runtime/sherpa-patches/apply_sherpa_patches.py \
  --archive .artifacts/sherpa-onnx/sherpa-onnx-v1.13.5.tar.gz \
  --staging-root .artifacts/sherpa-onnx/staged-v1.13.5 \
  --json
python tools/voice-runtime/run_sherpa_cmake.py \
  --artifact-root .artifacts/sherpa-onnx \
  --source-root .artifacts/sherpa-onnx/sources/extracted/sherpa-onnx-1.13.5 \
  --allow-aurora-pockettts-patches \
  -- cmake -S .artifacts/sherpa-onnx/sources/extracted/sherpa-onnx-1.13.5 \
         -B .artifacts/sherpa-onnx/builds/linux-x86_64
```

## Model artifact hygiene

Downloaded models, converted ONNX, WAVs, reports, and build trees belong in
`.artifacts/`. Never commit them.

## Native and WASM proof

Keep those builds sequential. WASM TTS must set
`AURORA_SHERPA_WASM_TTS_NEUTRAL=1` so Aurora mounts catalog packs at runtime.

```bash
uv run python tools/voice-runtime/pockettts-packs/smoke_synthesize.py --runtime native
uv run python tools/voice-runtime/pockettts-packs/smoke_synthesize.py --runtime wasm
```

## Temporary bootstrap publisher

`.github/workflows/sherpa-pockettts-language-packs.yml` converts the English
2026-04 and French 24l packs on `workflow_dispatch` or GitHub release, not on
ordinary pull requests. Remove the convert job after stable GitHub release
URLs exist.
