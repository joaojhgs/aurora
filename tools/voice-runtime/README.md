# Phase 4 native voice runtime manifest

Live Sherpa PocketTTS pin, patch queue, and native/WASM proof commands are in
[`docs/SHERPA_POCKETTTS.md`](../../docs/SHERPA_POCKETTTS.md) and
[`AGENTS.md`](AGENTS.md) in this directory.

This directory contains the source/model allowlist used by the Phase 4 native
voice runtime decision gate. The validator is intentionally stricter than the
older W0 candidate gates: release artifacts must have exact URLs, versions or
commits, SHA-256 digests, byte sizes, license evidence, and a non-placeholder
status before they can be selected.

```bash
python tools/voice-runtime/validate_phase4_manifest.py
python tools/voice-runtime/validate_phase4_manifest.py \
  --artifact-root /path/to/pockettts/p4-native-voice
```

The first command checks the immutable structural policy. The second also
hashes every declared archive and license file beneath the supplied evidence
root and rejects missing, wrong-size, wrong-hash, absolute, or escaping paths.
The manifest includes sherpa's core transitive sources; the current
Piper/piper-phonemize/espeak-ng chain is recorded but blocked from activation.

Run sherpa CMake configuration through the source-identity wrapper when an
extracted archive lives beneath another Git worktree:

```bash
python tools/voice-runtime/run_sherpa_cmake.py \
  --artifact-root /path/to/pockettts/p4-native-voice \
  --source-root /path/to/pockettts/p4-native-voice/sources/extracted/sherpa-onnx-1.13.5 \
  -- cmake -S /path/to/sherpa-onnx-1.13.5 -B /path/to/build
```

The wrapper verifies the pinned archive and records the expected upstream
commit, then prevents sherpa's CMake diagnostics from inheriting Aurora's Git
identity.

## Android native runtime

`build_sherpa_android.sh` produces the patched TTS/STT/VAD/KWS engine used by
Android packaging. It verifies the pinned Sherpa and ONNX Runtime downloads,
applies the PocketTTS queue, and builds `arm64-v8a` followed by `x86_64` with
bounded parallelism:

```bash
flock -x /tmp/aurora-global-build.lock \
  tools/voice-runtime/build_sherpa_android.sh
```

The default outputs are
`.artifacts/sherpa-onnx/android-runtime-build/runtime/<abi>/`. Pass those
directories as `AURORA_SHERPA_ONNX_ANDROID_ARM64_V8A_LIB_DIR` and
`AURORA_SHERPA_ONNX_ANDROID_X86_64_LIB_DIR` when building a universal APK/AAB.
CI uses the same script and never substitutes the stock upstream Sherpa binary
for Aurora's patched engine.

## Desktop and iOS native runtime

`build_sherpa_native.py` produces a self-contained static Sherpa link set for
the current Linux x64, macOS arm64, Windows x64, iOS arm64 simulator, or iOS
arm64 device target. It verifies the target-specific ONNX Runtime `1.27.1`
archive before configuring the verified patched source tree.
For iOS, the builder selects the requested XCFramework slice, thins a universal
simulator binary to the target architecture when necessary, and verifies the
result is a real static archive before Cargo can link it.

```bash
flock -x /tmp/aurora-global-build.lock \
  python tools/voice-runtime/build_sherpa_native.py --target host --jobs 2
export AURORA_SHERPA_ONNX_LIB_DIR="$PWD/.artifacts/sherpa-onnx/native-runtime-build/runtime/$(rustc -vV | sed -n 's/^host: //p')"
export AURORA_SHERPA_ONNX_LINK_KIND=static
```

The staged runtime includes `include/sherpa-onnx/c-api/c-api.h`. Native Cargo
builds compile an ABI layout probe against that pinned header. For an isolated
check, `AURORA_SHERPA_ONNX_INCLUDE_DIR` may point at another directory that
contains the same `sherpa-onnx/c-api/c-api.h` path; incompatible or missing
headers stop the build.

macOS/Xcode CI selects `aarch64-apple-ios-sim` for unsigned simulator packages
and `aarch64-apple-ios` for the optional signed device dry run. Build output,
downloaded sources, ONNX Runtime archives, and generated metadata remain under
`.artifacts/` and are never committed.

## KWS catalog compatibility

Aurora publishes the canonical full English GigaSpeech, Chinese WenetSpeech,
and bilingual Chinese/English KWS archives. The similarly named upstream
`-mobile` archives are batch-one graph conversions; sherpa-onnx 1.13.5 can
reach a two-hypothesis streaming decode and abort at the converted
`/downsample/Reshape_1` node. Do not restore those duplicate compact entries
until their exact quantized encoder/joiner bindings pass the native KWS smoke
with Aurora's production decoder. Excluding them does not reduce language
coverage because the full English, Chinese, and bilingual packs remain
available for on-demand installation.

Generated build outputs, downloaded model weights, and reports stay under
ignored artifact directories.
