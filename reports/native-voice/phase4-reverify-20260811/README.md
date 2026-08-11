# Phase 4 native voice architecture/portability re-verification

Recorded: 2026-08-11T22:56:04Z

Verdict: **pass for the bounded Phase 4 architecture and portability gate**.

This report does not claim an integrated production runtime, live desktop audio,
physical-device behavior, Apple compilation/signing, release packaging, or
production activation of PocketTTS or the evidence-only Piper path. Those gates
remain withheld or externally blocked in later phases.

## Fresh results

- The 24-artifact manifest validated against the materialized artifact root with
  `verified_local: true`, 24 artifacts, three explicit policy denials, and no
  errors.
- The sherpa-onnx source archive and extracted 5,424-entry tree matched their
  pinned archive, commit, and tree digests after temporary build links were
  removed.
- Linux native STT, VAD, KWS, evidence-only TTS, and TTS callback cancellation
  passed through the C API. The Rust FFI wrapper independently passed STT and
  one-callback TTS cancellation.
- Android `arm64-v8a` and `x86_64` sherpa libraries were rebuilt from the pinned
  source against the pinned ONNX Runtime package with NDK r27c. Every inspected
  `LOAD` segment in ONNX Runtime, sherpa C, C++, and JNI libraries is `0x4000`
  aligned.
- The pinned iOS ONNX Runtime and sherpa XCFrameworks contain device `arm64` and
  simulator `arm64` plus `x86_64` slices. Xcode compilation, runtime linking,
  signing, simulator execution, and device microphone behavior were not claimed
  on this Linux host.
- The split web shape built as one VAD+ASR module and one KWS module. Chromium,
  Firefox, and WebKit all passed worker-scope, cross-origin-isolated VAD, ASR,
  and KWS execution.
- Native and all three browser engines passed the six-case VAD parity matrix.
  Segment starts and lengths matched exactly; every accept-path p95 remained
  below the 32 ms ceiling.
- PocketTTS remains blocked by the inspected non-commercial pack. Piper/espeak
  remains evidence-only and withheld from activation. No production local
  VAD/KWS/STT/TTS capability was enabled by this verification.

## Reproduction commands

```bash
uv run python tools/voice-runtime/validate_phase4_manifest.py \
  --artifact-root .artifacts/pockettts/p4-native-voice

uv run python tools/voice-runtime/run_sherpa_cmake.py \
  --artifact-root .artifacts/pockettts/p4-native-voice \
  --source-root .artifacts/pockettts/p4-native-voice/sources/extracted/sherpa-onnx-1.13.4

uv run --extra test-e2e python \
  tools/voice-runtime/browser-probe/run_phase4_browser_probe.py \
  --artifact-root .artifacts/pockettts/p4-native-voice \
  --report-json .artifacts/pockettts/p4-native-voice/reports/phase4-browser-probe-20260811.json \
  --browser chromium --browser firefox --browser webkit --timeout-ms 180000

uv run --extra test-e2e python \
  tools/voice-runtime/vad-parity/run_vad_parity.py \
  --artifact-root .artifacts/pockettts/p4-native-voice \
  --lib-dir builds/linux-x86_64/install/lib \
  --report-dir .artifacts/pockettts/p4-native-voice/reports/vad-parity-20260811 \
  --browser chromium --browser firefox --browser webkit --timeout-ms 180000
```

The machine-readable adjudication is in `summary.json`. `checksums.sha256`
binds the concise report to the raw ignored reports and built binaries used in
the review. `android-alignment.txt` records the inspected ABI and segment data.

## Independent adjudication

An independent verifier re-ran the manifest validator, Rust 1.88 checks and
native tests, reviewed the raw browser/parity/C API reports, inspected Android
ELF alignment and iOS slices, and returned PASS for the bounded Phase 4 exit.
The verifier explicitly kept live CPAL, Apple runtime, physical-device,
signing, release, PocketTTS, and Piper activation claims out of scope.
