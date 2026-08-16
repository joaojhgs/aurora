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

## KWS catalog compatibility

Keep the canonical full GigaSpeech, WenetSpeech, and bilingual KWS archives in
the production catalog. The upstream `-mobile` archives are batch-one graph
conversions and currently abort when Aurora's streaming decoder reaches two
hypotheses. Reintroduce a compact KWS archive only after its exact quantized
production bindings pass the native smoke; never trade away English, Chinese,
or bilingual coverage to select it.

## Native and WASM proof

Acquire `/tmp/aurora-global-build.lock` for every convert, build, export, or
heavy test. Keep those builds sequential. WASM TTS must set
`AURORA_SHERPA_WASM_TTS_NEUTRAL=1` so Aurora mounts catalog packs at runtime.
The neutral build must emit an ES-module default factory and named TTS helper
exports that the production module worker can import unchanged. Never repair
or append those exports inside a test fixture.

Both language packs export at `STATIC_SEQ_LEN=10000` so production
`max_frames=500` fits. Public packs use `reference_audio_mode=internal` and
ship `fixed_voice_state.bin`; they do not ship or synthesize an internal
reference WAV. The schema-1 state is little-endian float32 Kyutai KV cache data
and is loaded on demand from the installed pack. Profile-mode packs continue to
require user reference audio.

Conversion, ONNX inlining, and graph optimization must run with the isolated
pinned Python exporter at `.artifacts/pockettts/export-venv/bin/python`, as
provisioned by the pack workflow. Do not import exporter-only ONNX tooling into
Aurora's normal Python runtime. The exporter's Python `onnxruntime` is a
graph-build tool and is independent of the Sherpa runtime's pinned ONNX Runtime
`1.27.1` binaries.

Patch 0003 seeds alternating LM cache/offset inputs and skips voice encoding for
fixed packs. Keep filesystem and Android/OHOS asset-manager sidecar loading in
sync. The C++ loader validates the fixed-state ABI and size; archive and
sidecar digests are enforced by the Aurora conversion/install boundary.

```bash
uv run python tools/voice-runtime/pockettts-packs/smoke_synthesize.py --runtime native
AURORA_SHERPA_WASM_TTS_NEUTRAL=1 tools/voice-runtime/build_sherpa_wasm_tts.sh
uv run python tools/voice-runtime/pockettts-packs/smoke_synthesize.py --runtime wasm
```

Android APK/AAB packaging must stage the patched native engine produced by
`tools/voice-runtime/build_sherpa_android.sh`; the stock upstream Android
archive is an ONNX Runtime/source comparison input, not Aurora's production
PocketTTS engine. The builder verifies the pinned source and ONNX Runtime
archives, applies the Aurora patch queue, builds `arm64-v8a` and `x86_64`
sequentially, and rejects native libraries without TTS or 16 KiB alignment.
Point the Android bundle wrapper at its two ABI output directories through the
existing `AURORA_SHERPA_ONNX_ANDROID_*_LIB_DIR` variables.

The WASM smoke is the Playwright driver in
`packages/aurora-voice-web/tests/playwright/sherpa-pockettts-browser-smoke.pw.ts`.
It must synthesize real audio for both locally built packs with Sherpa's
production `max_frames=500` default; do not add a smaller smoke-only cap.

## Temporary bootstrap publisher

`.github/workflows/sherpa-pockettts-language-packs.yml` converts the English
2026-04 and French 24l packs on `workflow_dispatch` or GitHub release, not on
ordinary pull requests. Remove the convert job after stable GitHub release
URLs exist.
