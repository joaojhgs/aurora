# Aurora Sherpa PocketTTS patch queue

Aurora does not maintain a permanent external fork of sherpa-onnx. Official
`v1.13.5` is staged from a pinned source archive, then this tightly scoped
downstream queue is applied.

## Upstream identity

| Field | Value |
| --- | --- |
| Version | `v1.13.5` |
| Tag commit | `3dc7c569f31ca2cd4a20ed6f7db780327e6714c5` |
| Archive | `https://github.com/k2-fsa/sherpa-onnx/archive/refs/tags/v1.13.5.tar.gz` |
| SHA-256 | `99f520db7364a06be0c174a385d03f9ccdbfe08f61146055229e4a990e285262` |
| Manifest id | `sherpa-onnx-source-v1.13.5` |

Official `v1.13.5` no longer publishes `sherpa-onnx-v*-ios.xcframework.zip`.
iOS builds from this same source archive / Swift Package Manager. Android and
OHOS asset-manager constructors load the protocol and fixed-state sidecars
through the same manager as their ONNX graphs. Live Android/Waydroid proof is
part of Aurora's final mobile release validation, not evidence implied by this
patch queue alone.

## Patch list

Apply in `series` order.

| Patch | SHA-256 | Purpose | Upstream files |
| --- | --- | --- | --- |
| `0001-pockettts-multilingual-protocol.patch` | `e4e745b1568b790e0625f5fd3da3cc131159f1cb73b6dee94fa85e301e60287d` | Native FP16 KV zeros (no per-token cast wrappers), protocol sidecar, `bos_before_voice` concat, EOS/frames/latent/dynamic empty-KV defaults, text flags | `sherpa-onnx/csrc/offline-tts-pocket-model.h`, `offline-tts-pocket-model.cc`, `offline-tts-pocket-impl.h` |
| `0002-wasm-tts-neutral-no-preload.patch` | `d92ad64c4c00c29ec85df0ec2f1a406eaa605090bed73fb4979f38ead54597f0` | Neutral WASM TTS build without `--preload-file` / `.data`, with an ES-module factory and helper exports for Aurora's controlled worker loader | `wasm/tts/CMakeLists.txt` |
| `0003-pockettts-fixed-voice-state.patch` | `640e64ba79fa038370310ed5bb5530f4c8d801ddc92c82d2feb56333828eb12a` | Load fixed Kyutai voice KV state without a synthetic reference WAV, seed alternating LM cache/offset inputs, skip reference encoding, and support filesystem plus Android/OHOS asset sidecars | `sherpa-onnx/csrc/offline-tts-pocket-model.h`, `offline-tts-pocket-model.cc`, `offline-tts-pocket-impl.h` |

English PocketTTS packs without `pocket_protocol.json` keep stock v1.13.5
behavior (`empty_kv_seq_len=1`, no BOS concat, `frames_after_eos=3`).

## Fixed-voice ABI

Public multilingual packs record a schema-1 `fixed_voice_state` object in
`pocket_protocol.json` and ship `fixed_voice_state.bin`. The binary is
little-endian float32, ordered by ascending transformer layer, with each layer
laid out as `[2, 1, frames, heads, head_dim]`. Sherpa maps each layer to the
alternating LM-main inputs `state_2n` (KV cache) and `state_2n+1` (int64
offset), seeds the offset with `frames`, and starts text conditioning from that
state. It does not run the public pack's zeroed voice encoder or require a
reference WAV.

Pack conversion verifies the sidecar SHA-256 and writes it into the protocol;
Aurora's signed catalog/archive installation verifies the downloaded archive.
The C++ loader independently rejects unknown schema/dtype, unsafe filenames,
unexpected state names, invalid dimensions, oversized allocations, and byte
size mismatches. It validates the recorded checksum format but does not embed a
second portable SHA-256 implementation; runtime integrity therefore relies on
Aurora's verified pack-install boundary.

## Stage and apply

```bash
python tools/voice-runtime/sherpa-patches/apply_sherpa_patches.py \
  --archive .artifacts/sherpa-onnx/sherpa-onnx-v1.13.5.tar.gz \
  --staging-root .artifacts/sherpa-onnx/staged-v1.13.5 \
  --json
```

The command verifies the archive digest, extracts it, applies `git apply`
`--unidiff-zero`, and prints the patched-tree identity over the four touched
files. Current patched-tree SHA-256:

`34c7feb1cc0bb94ad9f423f5a1a14cb977af86a8ac329644ec16de660371b3c3`

Native CMake must go through `tools/voice-runtime/run_sherpa_cmake.py` so the
source identity wrapper still suppresses an enclosing Aurora Git directory.

WASM TTS:

```bash
export AURORA_SHERPA_WASM_TTS_NEUTRAL=1
tools/voice-runtime/build_sherpa_wasm_tts.sh
```

The neutral build emits `sherpa-onnx-wasm-main-tts.js` as an Emscripten
ES-module factory and stages `sherpa-onnx-tts.js` with explicit named helper
exports. Aurora imports both directly inside its module worker; smoke tests
must consume the staged files unchanged and must not append exports at test
time.

## Upgrade / rebase

1. Confirm the new official tag from `https://github.com/k2-fsa/sherpa-onnx/releases`.
2. Download the source archive, record SHA-256 and tag commit.
3. Update `tools/voice-runtime/phase4_manifest.json`, `SHERPA_SOURCE_ID`, and
   `SHERPA_ONNX_VERSION`.
4. Extract the new archive and `git apply --check` each patch in `series`.
5. Rebase failed hunks against PocketTTS files only. Do not expand the queue
   into unrelated Sherpa subsystems.
6. Refresh patch SHA-256 values in this README and `PATCH_SHA256`.
7. Rebuild native then WASM sequentially. Do not run those heavy builds in
   parallel.

## Boundary

This queue is PocketTTS-only. Do not patch the Python PocketTTS provider,
Python model loader, or Python inference path. Graph folding/dedup for
language packs is conversion-time and lives in
`tools/voice-runtime/pockettts-packs/`.
