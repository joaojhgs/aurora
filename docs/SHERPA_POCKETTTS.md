# Sherpa PocketTTS multilingual runtime

**Status:** Current
**Audience:** contributors working on the Sherpa native/WASM PocketTTS path

This page is the live Sherpa PocketTTS pin. Phase 4 frozen evidence remains in
[`NATIVE_VOICE_RUNTIME_PHASE4.md`](NATIVE_VOICE_RUNTIME_PHASE4.md).

## Upstream

| Item | Value |
| --- | --- |
| sherpa-onnx | `v1.13.5` |
| Tag commit | `3dc7c569f31ca2cd4a20ed6f7db780327e6714c5` |
| Source archive | `https://github.com/k2-fsa/sherpa-onnx/archive/refs/tags/v1.13.5.tar.gz` |
| SHA-256 | `99f520db7364a06be0c174a385d03f9ccdbfe08f61146055229e4a990e285262` |
| ONNX Runtime | `v1.27.0` (unchanged) |

Official `v1.13.5` no longer publishes `ios.xcframework.zip`. iOS uses the same
source archive / SPM. Android and Waydroid testing are deferred for this task.

## Patch queue

Aurora applies a PocketTTS-only downstream queue. There is no permanent
external fork. See [`tools/voice-runtime/sherpa-patches/README.md`](../tools/voice-runtime/sherpa-patches/README.md).

```bash
python tools/voice-runtime/sherpa-patches/apply_sherpa_patches.py \
  --archive .artifacts/sherpa-onnx/sherpa-onnx-v1.13.5.tar.gz \
  --staging-root .artifacts/sherpa-onnx/staged-v1.13.5 --json
```

## Language packs

English `english_2026-04` and French `french_24l` are converted on demand from
official Kyutai sources. Weights are not in Git. The GitHub workflow
`sherpa-pockettts-language-packs` is a temporary bootstrap publisher: remove
its convert job after stable GitHub release URLs exist.

Current Kyutai mimi attention is a linear KV cache, not a ring buffer. Each
latent frame advances RoPE `offset` by 16 transformer steps. A decoder traced
at `STATIC_SEQ_LEN = 1000` overflows at frame 62. Until a pack is re-exported
at `STATIC_SEQ_LEN = 10000`, native and WASM proof pass
`extra.max_frames = 55`. Do not rewrite only the ONNX I/O dims on a 1000-step
graph.

## Proof commands

Acquire `/tmp/aurora-global-build.lock` for every convert, build, export, or
heavy test. Keep native and WASM builds sequential.

```bash
uv run python tools/voice-runtime/pockettts-packs/convert_language_pack.py \
  --pack aurora-pockettts-en-2026-04 --json
uv run python tools/voice-runtime/pockettts-packs/convert_language_pack.py \
  --pack aurora-pockettts-fr-24l --json
uv run python tools/voice-runtime/pockettts-packs/smoke_synthesize.py --runtime native
AURORA_SHERPA_WASM_TTS_NEUTRAL=1 tools/voice-runtime/build_sherpa_wasm_tts.sh
uv run python tools/voice-runtime/pockettts-packs/smoke_synthesize.py --runtime wasm
```

WASM TTS must set `AURORA_SHERPA_WASM_TTS_NEUTRAL=1` so Aurora mounts catalog
packs at runtime. The WASM smoke uses the production browser engine and must
not request a `.data` preload.

Voice cloning in the product UI takes a WAV sample only. Sherpa conditions from
audio; it does not invent a transcript.
