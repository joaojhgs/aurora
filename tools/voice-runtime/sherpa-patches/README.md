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
Waydroid testing are deferred for this PocketTTS task.

## Patch list

Apply in `series` order.

| Patch | SHA-256 | Purpose | Upstream files |
| --- | --- | --- | --- |
| `0001-pockettts-multilingual-protocol.patch` | `e4e745b1568b790e0625f5fd3da3cc131159f1cb73b6dee94fa85e301e60287d` | Native FP16 KV zeros (no per-token cast wrappers), protocol sidecar, `bos_before_voice` concat, EOS/frames/latent/dynamic empty-KV defaults, text flags | `sherpa-onnx/csrc/offline-tts-pocket-model.h`, `offline-tts-pocket-model.cc`, `offline-tts-pocket-impl.h` |
| `0002-wasm-tts-neutral-no-preload.patch` | `959b69d27457a658193404eb67233c5c0fabeb7009d575b0970ba883e83bddee` | Neutral WASM TTS build without `--preload-file` / `.data` so Aurora mounts catalog packs at runtime | `wasm/tts/CMakeLists.txt` |

English PocketTTS packs without `pocket_protocol.json` keep stock v1.13.5
behavior (`empty_kv_seq_len=1`, no BOS concat, `frames_after_eos=3`).

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

`9676de0fadce556b613b5b3d140ee4c89cfd65e17655570d99f6c7b44e00e805`

Native CMake must go through `tools/voice-runtime/run_sherpa_cmake.py` so the
source identity wrapper still suppresses an enclosing Aurora Git directory.

WASM TTS:

```bash
export AURORA_SHERPA_WASM_TTS_NEUTRAL=1
```

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
