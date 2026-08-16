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

## Mimi decoder KV cache

Current Kyutai attention is a linear cache, not a ring buffer. Each latent
frame advances RoPE `offset` by 16 transformer steps. The official helper
traces `STATIC_SEQ_LEN = 1000`, which overflows at frame 62 (`invalid Expand`).
Aurora's export patcher sets mimi `STATIC_SEQ_LEN = 10000` so Sherpa's default
`max_frames=500` fits. Do not rewrite only the ONNX I/O dims on a 1000-step
graph; the baked Reshape/Gather shapes still assume 1000.

## Model artifact hygiene

Downloaded models, converted ONNX, WAVs, reports, and build trees belong in
`.artifacts/`. Never commit them.

## Native and WASM proof

Acquire `/tmp/aurora-global-build.lock` for every convert, build, export, or
heavy test. Keep those builds sequential. WASM TTS must set
`AURORA_SHERPA_WASM_TTS_NEUTRAL=1` so Aurora mounts catalog packs at runtime.

Until a pack is re-exported at `STATIC_SEQ_LEN=10000`, both runtimes pass
`extra.max_frames=55` so the linear KV cache does not overflow at frame 62.

```bash
uv run python tools/voice-runtime/pockettts-packs/smoke_synthesize.py --runtime native
AURORA_SHERPA_WASM_TTS_NEUTRAL=1 tools/voice-runtime/build_sherpa_wasm_tts.sh
uv run python tools/voice-runtime/pockettts-packs/smoke_synthesize.py --runtime wasm
```

The WASM smoke is the Playwright driver in
`packages/aurora-voice-web/tests/playwright/sherpa-pockettts-browser-smoke.pw.ts`.
It must synthesize real audio for both locally built packs.

## Temporary bootstrap publisher

`.github/workflows/sherpa-pockettts-language-packs.yml` converts the English
2026-04 and French 24l packs on `workflow_dispatch` or GitHub release, not on
ordinary pull requests. Remove the convert job after stable GitHub release
URLs exist.
