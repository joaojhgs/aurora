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
