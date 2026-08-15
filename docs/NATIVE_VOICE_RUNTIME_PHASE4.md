# Native voice runtime Phase 4 decision record

**Status:** Current bounded check — Phase 4 architecture frozen
**Snapshot date:** 2026-08-14
**Audience:** contributors integrating the cross-surface local voice runtime

This page freezes the Phase 4 native voice runtime engine, audio, linking,
transport, model, and toolchain decisions. It authorizes the shared production
foundation work in Phase 5; it is not a completion claim for the native voice
runtime or for any later device release. Every pending row remains unverified
until the corresponding build, device, browser, or parity check has a fresh
report.

## Superseded TypeScript prototype disposition

The former `@aurora/local-speech` workspace package was a provider-neutral
manifest/lifecycle/storage prototype. It had no production imports. Its
trust-boundary, lifecycle, atomic-install, revocation, quota, and rollback
semantics are now covered by the Rust `aurora-voice-engine` and
`aurora-voice-testkit` model-pack/store contracts and tests. The unused package
was retired from the workspace during the Phase 8/9 integration cleanup so
there is one production ownership path and one generated model-pack contract.
The benchmark fixtures under `benchmarks/local-speech/` remain comparison
inputs only and are not client runtime code.

## Decision boundary

Phase 4 chooses the native runtime direction and fail-closed dependency set for
later implementation phases. Phase 6 release disposition is tracked in
`tools/voice-runtime/model-packs/candidates/phase6-capability-disposition.json`;
candidate manifests referenced there are validation inputs only and remain
excluded from release eligibility until a later release decision changes that
file and its gates.

The later production implementation now uses a separate metadata-only catalog
boundary. Aurora lists pinned upstream speech and voice metadata, presents the
associated terms, and downloads only the exact pack chosen by explicit user
choice. Aurora does not bundle or redistribute model weights, does not download
them automatically, and activates a capability only after the chosen archive is
hash-verified, installed in application-private cache, and selected for the
matching task. The older Phase 4 candidate manifests remain bounded validation
evidence; they are not the production catalog or a default-pack decision.

- Rust `1.88.0` is the pinned local build toolchain for this lane.
  The Tauri crate declaration and native CI workflows are aligned to that
  minimum after the complete Phase 4 build matrix.
- sherpa-onnx `v1.13.4`, ONNX Runtime `v1.27.0`, CPAL `v0.18.1`, and
  Emscripten `4.0.23` are the pinned runtime/build inputs for the Phase 4
  validation shape.
- The Phase 4 validation-only model set is English-only for ASR, VAD, and KWS:
  offline Moonshine v2 ASR, upstream Silero VAD v4.0, and GigaSpeech KWS.
  Piper LJSpeech medium TTS is evidence-only and is not a bundled default; the
  later metadata catalog supplies user-selected Piper voices on demand.
- PocketTTS is available as an explicitly selected, user-downloaded upstream
  voice. Its restricted non-commercial terms remain visible, Aurora does not
  redistribute or auto-download the archive, and activation requires a valid
  user-provided reference profile.
- The sherpa-exported Silero derivative is rejected for the reproducible default
  pack because its exact byte-for-byte export recipe is not validated. The
  upstream Silero v4.0 ONNX file is the Phase 4 validation input after exact
  native/WASM compatibility checks.

## Pinned sources and artifacts

| Input | Version or revision | SHA-256 | Current status |
| --- | --- | --- | --- |
| sherpa-onnx source archive | `v1.13.4`, tag commit `142807252687d81b40d6315f23470a1512a00de3` | `3243cb386d3a4ac87596adf7d2c89fddf23e2948b154942b987b4d91c1fee295` | Pinned |
| ONNX Runtime source archive | `v1.27.0`, commit `8f0278c77bf44b0cc83c098c6c722b92a36ac4b5` | `b41d09905a3c2f3a25709d1dcce8ef3942a4c2799d1046f74be7b6bbebc45e6a` | Pinned |
| ONNX Runtime Linux x64 probe package | `1.27.0`, glibc 2.17 release | `9f0c0a6998f1b94c399eeddcb443beb4a922c9a4fd431fdc9cd6de67a1935d00` | Exact prebuilt consumed by the Linux shared-library probe; the source archive above is provenance input, not a source-build claim |
| CPAL crates.io package | `v0.18.1` | registry checksum `5f77b11176c37874be37e8d691c946e31b2b8c357abce9526f6a99eb469e1028` | Pinned in `rust/Cargo.lock` and `tools/voice-runtime/phase4_manifest.json`; source archive provenance is not claimed |
| Emscripten SDK archive | `4.0.23` | `a91a4c1f42dbb0345faac093161e27d43e9b6964840d8c8d80976ab8d3eaf2d3` | Pinned |
| ONNX Runtime Android package | `1.27.0` | `a78f303a26b5e75c84c8b2a97fa2ddb400b2d1b5e069bec19aa229ccd3597fdb` | Pinned; staged prebuilt for Android source builds |
| ONNX Runtime WASM SIMD static package | `1.27.0` | `076680969c74225caf0a6d08c0be5edd2c242b081c33cede77dcc5eac355bbcf` | Pinned |
| ONNX Runtime iOS static XCFramework | `1.27.0` | `2c4b6eda7fcf03ca51814bbc88e3709cc080e623581fce085286182cc30d60c1` | Pinned; slice inspection complete |
| sherpa-onnx Android package | `v1.13.4` | `7983fc3de23f6e64148f2fb05fa94a2efaa8c0516cc1573383dc5c7d4d2a43b0` | Pinned |
| sherpa-onnx iOS XCFramework | `v1.13.4` | `c5a62904bba73edc4bac89bbf51b4c3db1dd6c1b397a16ee95b2ff94701e9846` | Pinned; slice inspection complete |

The machine manifest also pins every dependency fetched by the exercised
sherpa builds: kaldi-native-fbank, KissFFT, kaldi-decoder, kaldifst, OpenFST,
Eigen, simple-sentencepiece, and nlohmann/json. Piper-phonemize and espeak-ng
are recorded at their exact source revisions but remain excluded from bundled
client artifacts. Supplying an
artifact root to `tools/voice-runtime/validate_phase4_manifest.py` verifies all
24 declared source, crate, model, and package artifacts plus license evidence
files by path, size, and SHA-256. The structural validator also checks the CPAL
manifest row against `rust/Cargo.lock` and this decision record so future CPAL
version or checksum drift fails before Phase 4 evidence is accepted.

## Phase 4 validation model candidates

| Function | Candidate | SHA-256 | Decision |
| --- | --- | --- | --- |
| ASR | `sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27` | `9ec31b342d8fa3240c3b81b8f82e1cf7e3ac467c93ca5a999b741d5887164f8d` | Phase 4 English-only offline Moonshine v2 validation input; broader production language selection comes from the later metadata catalog |
| VAD | upstream `silero-vad-v4.0.onnx` | `a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28` | Phase 4 validation input after native and WASM parity; the embedded WASM data range is byte-identical to this pinned file |
| KWS | `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01` | `f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a` | Phase 4 English BPE validation input; the smaller `-mobile` pack is disqualified until its ONNX Runtime reshape abort is resolved |
| TTS | `vits-piper-en_US-ljspeech-medium` | `3dfb4b759d8be032a4903a9538d128b0fda2a06ab1de6cbc2d93a97e2dd83dba` | Phase 4 C API validation input only; not a bundled default. Production Piper voices come from explicit on-demand catalog selection |

Moonshine extracted file hashes already recorded for integration:

- `encoder_model.ort`: `94e90a4654fc45cdfedb77c4c08e1739f48862998e58fada384b25118134f221`
- `decoder_model_merged.ort`: `cf524c4862d36e9e5ab032eddc73637efd822d70e868ac575cf1a46e1e4708a0`
- `tokens.txt`: `2870d843e14c1e187bf1913a521562a63b53933814bd7f2145120468f494a049`

## Platform data-plane decisions

| Surface | Decision | Current status |
| --- | --- | --- |
| Desktop local | Use Rust host code for model lifecycle and native HTTP/SSE; use CPAL `0.18.1` for the Phase 4 desktop audio validation path. | Linux sherpa shared-library build completed. Standalone CPAL capture/playback and Android comparison checks passed; the full integrated local audio path remains pending. |
| Hosted web and WebView foreground capture | Use browser microphone capture and worker-hosted WASM modules; keep the UI thread nonblocking. | Chromium, Firefox, and WebKit pass worker-hosted VAD, Moonshine ASR, and KWS with COOP/COEP and `SharedArrayBuffer`. KWS uses the Phase 4 validation full GigaSpeech BPE pack and detects `LOVELY CHILD` and `FOREVER`; the smaller mobile pack remains disqualified by the ONNX Runtime reshape abort. The later browser runtime activates TTS only after explicit voice selection and verified cache installation. |
| Android | Use Kotlin `AudioRecord`/`AudioManager` lifecycle and data plane into Rust with bounded PCM transfer. Treat CPAL/AAudio as comparison only for this phase. | sherpa source-built for `arm64-v8a` and `x86_64` against staged prebuilt ONNX Runtime. All four inspected libraries are ELF-correct and every LOAD segment is `0x4000` aligned. Kotlin audio ingress through JNI into a bounded Rust PCM queue packages for `arm64-v8a` and `x86_64`; the API 35 x86_64 emulator smoke proves synthetic JNI ingress and permission-granted `AudioRecord` frames reaching Rust. WebView parity, durable background voice, physical-device results, and Android sherpa VAD/STT runtime remain pending. |
| iOS | Use Swift `AVAudioEngine`/`AVAudioSession` lifecycle and data plane into Rust. Treat CPAL/CoreAudio as comparison only for this phase. | The Rust `IosVoiceSession` executor now owns typed Gateway HTTP/SSE STT/TTS transport, generation/cancellation, bounded ingress/egress, and redacted status. Swift owns AVAudioEngine capture, AVAudioPlayerNode playback, Keychain-backed native credentials, PTT finish/cancel, and fail-closed interruption/route/media-reset handling. App background/lock/termination and low-power notifications are explicitly handled; only a future user-started background session may survive backgrounding or lock. Hash-pinned XCFrameworks contain the expected device `arm64`/iOS slice and simulator `arm64`+`x86_64`/iOSSimulator slices. Swift compilation, runtime linking, signing, simulator execution, device microphone behavior, and packaged runtime validation remain pending. |

## Validated, rejected, and pending

| Area | Status | Boundary |
| --- | --- | --- |
| Linux sherpa source build | Validated locally | sherpa `v1.13.4` configured with the exact pinned ONNX Runtime Linux x64 prebuilt, TTS enabled for evidence, C API enabled, and installed shared libraries. The source-identity wrapper pins the sherpa archive/commit and suppresses an enclosing Aurora Git identity. |
| Android source-build package alignment | Validated locally for `arm64-v8a` and `x86_64` | ONNX Runtime remains staged prebuilt. sherpa was source-built for both ABIs, all four inspected libraries were ELF-correct, and every LOAD segment reported `0x4000` alignment. |
| Android audio-to-Rust ingress | Validated locally on package build and API 35 x86_64 emulator | Kotlin `AudioRecord`/`AudioManager` owns capture lifecycle, a JNI shim calls a narrow Rust C ABI, and Rust `1.88.0` owns bounded PCM queueing, backpressure, discontinuity counting, shutdown, and null-safe FFI. The debug APK includes `classes.dex` plus `arm64-v8a` and `x86_64` JNI libraries. Emulator logcat reported `synthetic result ok=true accepted=2 dropped=0 queued=2` and `capture result ok=true acceptedDelta=11 samplesDelta=17600 dropped=3`. Physical-device runtime remains pending. |
| Android emulator runtime | Partly validated with software acceleration | API 35 x86_64 boots and runs the Android audio ingress smoke when started without KVM acceleration. API 35 ARM64 remains rejected by QEMU2 on this x86_64 host. Android sherpa VAD/STT runtime and physical-device checks remain pending. |
| iOS XCFramework slice inspection | Validated locally for downloaded packages | Hash-pinned ONNX Runtime and sherpa XCFrameworks expose device `arm64`/iOS and simulator `arm64`+`x86_64`/iOSSimulator slices. Runtime link, signing, simulator, and physical-device checks remain pending. |
| iOS audio-to-Rust/session boundary | Validated as source structure and host-Rust behavior | Swift `AVAudioSession`/`AVAudioEngine` capture and `AVAudioPlayerNode` playback feed a narrow C ABI backed by a Rust `1.88.0` bounded PCM queue and Gateway session executor. Rust tests validate behavior for input validation, backpressure, discontinuity accounting, reset, generation-safe finish/cancel, transport redaction, and start-stop-start semantics; structural tests validate native credential storage, typed PTT finish, playback acknowledgement, and fail-closed AVAudio/app lifecycle handling. Swift/Xcode compilation, linking, simulator execution, and physical microphone behavior are not claimed on this Linux host. |
| Rust MSRV | Validated and declared for the current lockfile | `cargo +1.88.0 check --locked` passed; older Rust `1.85.1` failed on locked dependency MSRV requirements. Tauri and native CI now pin `1.88.0`. |
| PocketTTS production use | Enabled on demand | Aurora ships metadata and runtime code only. The user explicitly selects and downloads the pinned upstream archive under its displayed restricted terms; Aurora does not bundle, redistribute, or auto-download it. |
| sherpa-exported Silero VAD | Rejected as default | The byte file is traceable as a k2-fsa-exported Silero v4 derivative, but the exact reproducible export recipe is missing. |
| Piper/espeak TTS voice packs | Enabled on demand | Aurora does not bundle voice archives. The user selects an upstream Piper voice, its terms are presented, the archive is downloaded directly into private cache, and its immutable hash and bindings are verified before activation. The Phase 4 compiler warnings remain provenance for runtime hardening and physical-device validation. |
| Native C API parity and TTS cancellation | Validated locally | ASR, VAD, KWS, TTS generation, and TTS callback cancellation probes pass against the local validation/evidence packs. A Rust `1.88.0` wrapper validates header-backed C ABI ownership, STT, and callback cancellation without mirroring sherpa config structs in Rust. Production activation remains exact-pack and user-initiated. |
| Native HTTP/SSE transport | Validated for a bounded live loopback server | Rust `1.88.0` tests validate ordered event parsing, cancellation, redaction, and bounded non-success bodies, including multibyte input. A live Aurora Gateway process, authentication lifecycle, reconnect, and end-to-end turn remain Phase 5+ work. |
| WASM linking | Validated locally with the Phase 4 split | One combined VAD+Moonshine STT module and one separate KWS module run behind narrow Worker host boundaries. TTS uses its separate worker/runtime path after explicit voice installation. The combined module embeds the exact Phase 4 validation upstream Silero file. |
| WASM parity and browser nonblocking behavior | Validated locally in Chromium, Firefox, and WebKit | All three browsers decoded the Moonshine test WAV and exercised KWS with the Phase 4 validation pack. The modules ran in dedicated Workers with cross-origin isolation and `SharedArrayBuffer`, while page timers continued. Fresh verification regenerates hashes and ignored local reports; CI artifacts retain per-run output. The smaller mobile KWS archive remains rejected by the ONNX Runtime reshape abort. |
| iOS runtime evidence | Implementation enabled; Apple-host validation pending | Linux source/host tests establish the typed native session boundary but do not validate Swift compilation, simulator, device, microphone, signing, or App Store readiness. Runtime readiness is derived from the exact installed and active packs; the missing Apple-host evidence does not hard-disable the implementation. |

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

## Phase 4 exit decision

Phase 4 exits with one Rust orchestration core and task-specific sherpa adapters;
it does not authorize a new inference engine. Desktop uses CPAL as its Phase 4
validation audio path, Android uses Kotlin `AudioRecord` into Rust, iOS uses Swift
`AVAudioEngine` into Rust, and pure web uses browser capture with dedicated
Workers. The Phase 4 validation web linking shape is a combined VAD+STT module plus a
separate KWS module. Native HTTP/SSE is the initial transport boundary.

The current iOS implementation extends the Phase 4 boundary with a Rust-owned
native session executor and Swift-owned audio lifecycle: credentials are stored
in a device-only Keychain item, PTT finish and cancel remain separate commands,
playback drains acknowledged Rust PCM chunks, and interruptions, unusable route
changes, and media-services resets cancel the active generation. These are
source/host-tested integration boundaries only; no Apple runtime or distribution
claim is made.

The reproducible dependency manifest, native and WASM builds, native callback
cancellation, browser parity/nonblocking matrix, Rust `1.88.0` pin, Android
emulator capture ingress, and bounded iOS source/host-Rust spike satisfy the
Phase 4 architecture and portability gate. Phase 5 production-foundation work
is authorized.

The Phase 4 reconstruction writes ignored local output. Fresh verification
must regenerate the hashes and use CI artifacts for retained per-run evidence,
while keeping external platform and activation exclusions explicit.

This Phase 4 receipt does not itself prove Android/iOS physical-device quality,
background endurance, store review, or signed distribution. Later phases now
provide the integrated production runtime and metadata-only on-demand catalogs;
their capability status is derived from the exact installed and active pack,
not from this historical candidate gate. Generated logs, archives, model
extracts, and run outputs remain under ignored `.artifacts/` or package-local
report directories. Keep benchmark candidates in
`benchmarks/local-speech/stt/candidates.json` aligned with this record whenever
model revisions or engine roles change.
