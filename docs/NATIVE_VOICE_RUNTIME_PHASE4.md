# Native voice runtime Phase 4 decision record

**Status:** Current bounded check
**Snapshot date:** 2026-08-07
**Audience:** contributors integrating the cross-surface local voice runtime

This page records the Phase 4 native voice runtime decision inputs that are
known in the current workstream. It is not a completion claim for the native
runtime. Treat every pending row as blocked until the corresponding build,
device, browser, or parity check has a fresh report.

## Decision boundary

Phase 4 chooses the native runtime direction and fail-closed dependency set for
later implementation phases:

- Rust `1.88.0` is the selected local build toolchain for this lane. The Tauri
  crate lock currently requires Rust dependencies newer than the stale
  `rust-version = "1.77.2"` declaration.
- sherpa-onnx `v1.13.4`, ONNX Runtime `v1.27.0`, CPAL `v0.17.3`, and
  Emscripten `4.0.23` are the pinned runtime/build inputs under evaluation.
- The selected first-pass model set is English-only: offline Moonshine v2 ASR,
  upstream Silero VAD v4.0, GigaSpeech KWS, and Piper LJSpeech medium TTS.
- PocketTTS model packs remain hard-disabled for production use because the
  currently inspected pack is non-commercial. Package code availability does not
  make any PocketTTS model or voice asset redistributable.
- The sherpa-exported Silero derivative is rejected for the reproducible default
  pack because its exact byte-for-byte export recipe is not proven. The upstream
  Silero v4.0 ONNX file is the candidate that must be compatibility-tested.

## Pinned sources and artifacts

| Input | Version or revision | SHA-256 | Current status |
| --- | --- | --- | --- |
| sherpa-onnx source archive | `v1.13.4`, tag commit `142807252687d81b40d6315f23470a1512a00de3` | `3243cb386d3a4ac87596adf7d2c89fddf23e2948b154942b987b4d91c1fee295` | Pinned |
| ONNX Runtime source archive | `v1.27.0`, commit `8f0278c77bf44b0cc83c098c6c722b92a36ac4b5` | `b41d09905a3c2f3a25709d1dcce8ef3942a4c2799d1046f74be7b6bbebc45e6a` | Pinned |
| CPAL source archive | `v0.17.3`, commit `fd3b945bffcaa493fa7cb5ceddf9db1f9330fd30` | `1997859032580ec8a45235d8aeee093f12c69780c27051411de83d415028d14f` | Pinned |
| Emscripten SDK archive | `4.0.23` | `a91a4c1f42dbb0345faac093161e27d43e9b6964840d8c8d80976ab8d3eaf2d3` | Pinned |
| ONNX Runtime Android package | `1.27.0` | `a78f303a26b5e75c84c8b2a97fa2ddb400b2d1b5e069bec19aa229ccd3597fdb` | Pinned; staged prebuilt for Android source builds |
| ONNX Runtime WASM SIMD static package | `1.27.0` | `076680969c74225caf0a6d08c0be5edd2c242b081c33cede77dcc5eac355bbcf` | Pinned |
| ONNX Runtime iOS static XCFramework | `1.27.0` | `2c4b6eda7fcf03ca51814bbc88e3709cc080e623581fce085286182cc30d60c1` | Pinned; slice inspection complete |
| sherpa-onnx Android package | `v1.13.4` | `7983fc3de23f6e64148f2fb05fa94a2efaa8c0516cc1573383dc5c7d4d2a43b0` | Pinned |
| sherpa-onnx iOS XCFramework | `v1.13.4` | `c5a62904bba73edc4bac89bbf51b4c3db1dd6c1b397a16ee95b2ff94701e9846` | Pinned; slice inspection complete |

## Selected model candidates

| Function | Candidate | SHA-256 | Decision |
| --- | --- | --- | --- |
| ASR | `sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27` | `9ec31b342d8fa3240c3b81b8f82e1cf7e3ac467c93ca5a999b741d5887164f8d` | Selected English-only offline Moonshine v2 candidate; multilingual and auto-language claims remain blocked |
| VAD | upstream `silero-vad-v4.0.onnx` | `a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28` | Selected candidate; sherpa compatibility still pending |
| KWS | `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01-mobile` | `2e6ac2577310bfa2f4b6b5fab0478b868c9d0b2cb2c51b3e13b50581b588864d` | Selected English BPE candidate |
| TTS | `vits-piper-en_US-ljspeech-medium` | `3dfb4b759d8be032a4903a9538d128b0fda2a06ab1de6cbc2d93a97e2dd83dba` | Selected English single-speaker candidate; compiler warning remains open |

Moonshine extracted file hashes already recorded for integration:

- `encoder_model.ort`: `94e90a4654fc45cdfedb77c4c08e1739f48862998e58fada384b25118134f221`
- `decoder_model_merged.ort`: `cf524c4862d36e9e5ab032eddc73637efd822d70e868ac575cf1a46e1e4708a0`
- `tokens.txt`: `2870d843e14c1e187bf1913a521562a63b53933814bd7f2145120468f494a049`

## Platform data-plane decisions

| Surface | Decision | Current status |
| --- | --- | --- |
| Desktop local | Use Rust host code for model lifecycle and native HTTP/SSE; use CPAL `0.17.3` as the desktop audio capture/playback candidate. | Linux sherpa shared-library build completed. Standalone CPAL capture/playback and Android comparison checks passed; the full integrated local audio path remains pending. |
| Hosted web and WebView foreground capture | Use browser microphone capture and worker-hosted WASM modules; keep the UI thread nonblocking. | WASM builds must cover VAD, combined offline VAD+ASR, KWS, and TTS modules. Browser worker parity remains pending. |
| Android | Use Kotlin `AudioRecord`/`AudioManager` lifecycle and data plane into Rust with bounded PCM transfer. Treat CPAL/AAudio as comparison only for this phase. | sherpa source-built for `arm64-v8a` and `x86_64` against staged prebuilt ONNX Runtime. All four inspected libraries are ELF-correct and every LOAD segment is `0x4000` aligned. Native model execution, WebView parity, durable background voice, and physical-device results remain pending. |
| iOS | Use Swift `AVAudioEngine`/`AVAudioSession` lifecycle and data plane into Rust. Treat CPAL/CoreAudio as comparison only for this phase. | Hash-pinned XCFrameworks contain the expected device `arm64`/iOS slice and simulator `arm64`+`x86_64`/iOSSimulator slices. Runtime linking, signing, simulator execution, device microphone behavior, and packaged runtime validation remain pending. |

## Proven, rejected, and pending

| Area | Status | Boundary |
| --- | --- | --- |
| Linux sherpa source build | Proven locally | sherpa `v1.13.4` configured with ONNX Runtime `1.27.0`, TTS enabled, C API enabled, and installed shared libraries. |
| Android source-build package alignment | Proven locally for `arm64-v8a` and `x86_64` | ONNX Runtime remains staged prebuilt. sherpa was source-built for both ABIs, all four inspected libraries were ELF-correct, and every LOAD segment reported `0x4000` alignment. |
| iOS XCFramework slice inspection | Proven locally for downloaded packages | Hash-pinned ONNX Runtime and sherpa XCFrameworks expose device `arm64`/iOS and simulator `arm64`+`x86_64`/iOSSimulator slices. Runtime link, signing, simulator, and physical-device checks remain pending. |
| Rust MSRV | Proven locally for current lockfile | `cargo +1.88.0 check --locked` passed; older Rust `1.85.1` failed on locked dependency MSRV requirements. |
| PocketTTS production use | Rejected | The inspected model pack is non-commercial. Do not ship, auto-download, or advertise it for production. |
| sherpa-exported Silero VAD | Rejected as default | The byte file is traceable as a k2-fsa-exported Silero v4 derivative, but the exact reproducible export recipe is missing. |
| Piper/espeak TTS source build | Open risk | The Linux build emitted upstream espeak-ng `-Wstringop-overflow` warnings in `langopts.c`. Treat TTS source-build acceptance as pending until this warning is triaged or a safer pinned path is selected. |
| Native C API parity and TTS cancellation | Pending | ASR/VAD/KWS/TTS probes must run against the selected packs, including callback cancellation for TTS. |
| WASM parity and browser nonblocking behavior | Pending | VAD, combined offline VAD+ASR, KWS, and TTS modules must be built and exercised in a worker-hosted browser path. |
| iOS runtime evidence | Pending external platform work | Linux-only inspection does not prove simulator, device, microphone, Swift runtime, signing, or App Store readiness. |

## Comparison candidates

The following remain comparison candidates only. They are useful for benchmarks,
regression checks, or alternative-engine pressure testing, but they do not own
the Phase 5 production runtime unless a later decision record replaces this one.

| Candidate | Role |
| --- | --- |
| Transformers.js Whisper and Transformers.js Moonshine | Browser/mobile comparison baselines for latency, memory, WebGPU/WASM behavior, and English-only limitations. |
| whisper.cpp WASM | Portability comparison baseline. |
| PocketTTS-Raven | Conversion and browser/mobile comparison evidence only; not a production owner until official provenance, license, equivalence, cancellation, thermal, and device gates pass. |
| Candle | Rust ML comparison path only; no production ownership is assigned in Phase 4. |

## Integration requirements before Phase 5 claims

- Replace placeholder/pending status with exact reports only after the root
  integration lane verifies them.
- Keep generated logs, archives, model extracts, and run outputs under ignored
  `.artifacts/` or package-local report directories.
- Do not promote any candidate to production default from fixture, schema-only,
  Linux-only, unavailable, or single-surface evidence.
- Keep benchmark candidates in `benchmarks/local-speech/stt/candidates.json`
  aligned with this record when model revisions or engine roles change.
