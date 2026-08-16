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
| ONNX Runtime | `v1.27.1` |

Official `v1.13.5` no longer publishes the old release-specific iOS archive.
Aurora builds its patched iOS C API from the same pinned source and links the
pinned ONNX Runtime static xcframework. Patch 0003 also loads PocketTTS protocol/BOS/fixed-state
sidecars through Android and OHOS asset managers. Live Waydroid foreground and
background voice validation is a separate device gate and is not implied by
the source patch alone.

The language-pack builder provisions a separate, version-pinned Python export
environment under `.artifacts/`. Its Python ONNX tools are used only to export,
inspect, quantize, optimize, and inline graphs; they are not shipped in Aurora
and do not replace the native/WASM ONNX Runtime `1.27.1` pin above. Conversion
fails closed when that pinned environment or any required rewrite is missing;
there is no publishable unoptimized-pack bypass.

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
official Kyutai sources. Weights are not in Git. The ONNX export helper is
pinned to `csukuangfj/pocket-tts-onnx-export` @
`f075c00bf4bbfbb081a11fd99abbf39df3849e0c` (2026-02-10). Each conversion
stages a clean checkout under `.artifacts/`; a dirty or wrong cached helper
is not reused. Pack archives are written with sorted members and normalized
uid/gid/uname/gname/mtime/mode so local catalog digests can match CI.
The GitHub workflow `sherpa-pockettts-language-packs` is a temporary
bootstrap publisher: remove its convert job after stable GitHub release URLs
exist.

Current Kyutai mimi attention is a linear KV cache, not a ring buffer. Each
latent frame advances RoPE `offset` by 16 transformer steps. A decoder traced
at `STATIC_SEQ_LEN = 1000` overflows at frame 62. Aurora export sets
`STATIC_SEQ_LEN = 10000` so Sherpa's default `max_frames=500` fits. Do not
rewrite only the ONNX I/O dims on a 1000-step graph.

Aurora English 2026-04 and French 24l packs are public fixed-voice conversions
from `kyutai/pocket-tts-without-voice-cloning` @
`e041936c75475d350b405bc870bcf7c22da4e9e6` (CC-BY-4.0). Their encoder was
zeroed by Kyutai's public export, so they are not clone-capable. Each pack
ships the pinned Kyutai voice cache as `fixed_voice_state.bin` and sets
`reference_audio_mode=internal`. The schema-1 binary is little-endian float32
with one `[2, 1, frames, heads, head_dim]` cache per transformer layer. Sherpa
seeds alternating LM cache/offset inputs and skips reference-audio encoding.
No reference WAV is generated, downloaded, or embedded. The official
`sherpa-onnx-pocket-tts-int8-2026-01-26` English pack stays
`reference_audio_mode=profile` and still requires user-provided reference
audio.

Conversion verifies the fixed-state SHA-256 and the signed/catalog pack path
verifies the archive before installation. The C++ loader validates schema,
filename safety, dimensions, state ordering, allocation bounds, and exact byte
size. It validates the checksum field's format but relies on Aurora's verified
pack-install boundary for the cryptographic digest check.

## Proof commands

Acquire `/tmp/aurora-global-build.lock` for every convert, build, export, or
heavy test. Keep native and WASM builds sequential.

```bash
uv run python tools/voice-runtime/pockettts-packs/convert_language_pack.py \
  --pack aurora-pockettts-en-2026-04 --json
uv run python tools/voice-runtime/pockettts-packs/convert_language_pack.py \
  --pack aurora-pockettts-fr-24l --json
uv run python tools/voice-runtime/pockettts-packs/smoke_synthesize.py --runtime native
python tools/voice-runtime/build_sherpa_native.py --target host --jobs 2
AURORA_SHERPA_WASM_TTS_NEUTRAL=1 tools/voice-runtime/build_sherpa_wasm_tts.sh
uv run python tools/voice-runtime/pockettts-packs/smoke_synthesize.py --runtime wasm
```

WASM TTS must set `AURORA_SHERPA_WASM_TTS_NEUTRAL=1` so Aurora mounts catalog
packs at runtime. The WASM smoke uses the production browser engine and must
not request a `.data` preload. The neutral build emits an Emscripten ES-module
default factory plus named TTS helper exports; the browser smoke imports the
staged release files unchanged rather than patching them in the test fixture,
and it uses Sherpa's production `max_frames=500` default.

Voice cloning in the product UI takes a WAV sample only. Sherpa conditions from
audio; it does not invent a transcript.

Desktop and iOS Tauri builds set `AURORA_SHERPA_ONNX_LIB_DIR` to the staged
target directory and `AURORA_SHERPA_ONNX_LINK_KIND=static`. The builder stages
the complete Sherpa/ONNX Runtime archive set so unsigned packages do not depend
on unbundled host shared libraries. Android continues to use its two patched,
16-KiB-aligned shared-library ABI directories.
