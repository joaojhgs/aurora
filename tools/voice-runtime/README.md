# Phase 4 native voice runtime manifest

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
  --source-root /path/to/pockettts/p4-native-voice/sources/extracted/sherpa-onnx-1.13.4 \
  -- cmake -S /path/to/sherpa-onnx-1.13.4 -B /path/to/build
```

The wrapper verifies the pinned archive and records the expected upstream
commit, then prevents sherpa's CMake diagnostics from inheriting Aurora's Git
identity.

Generated build outputs, downloaded model weights, and reports stay under
ignored artifact directories.
