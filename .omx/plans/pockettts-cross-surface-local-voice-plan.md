# Cross-Surface Native/WASM Voice Runtime and Background Activity Plan

**Status:** replacement implementation plan; the former Phase 4 and later TypeScript/WebView runtime plan is superseded

**Date:** 2026-08-06

**Scope:** local microphone capture, push-to-talk, wakeword, VAD, STT, TTS, voice profiles, model delivery, background voice turns, and Aurora request/response handling across desktop Tauri with or without a Python sidecar, Android, iOS, pure web, and existing Python nodes

**Planning-only change:** this document changes no production source, dependency, lockfile, configuration, generated artifact, or integration branch.

**2026-08-14 execution disposition:** the full Phase 0-13 objective remains in scope. Current implementation uses metadata-only speech catalogs: no model or voice weights are committed or embedded in client bundles, the exact user-selected language/model/voice pack is downloaded on demand, verified, and retained in the surface-appropriate private cache. VAD, KWS, STT, and TTS are production capabilities on every applicable surface and runtime role; “on demand” means available after selection and installation, not disabled or installed by default. The current packaging objective is unsigned internal packages for every host this Linux workspace can build; signing, notarization, and store publication are a later release operation. Historical pack-redistribution, license-approval, and “keep speech false” gates below do not block this on-demand catalog policy. Platform invariants still apply: pure web is foreground/focus bounded, iOS does not claim silent perpetual restart or Siri replacement, and physical-device/cross-host/acoustic qualification must be reported as external evidence rather than converted into removed features.

**Preserved implementation baseline:** the Python provider/configuration work and typed speech contract/routing work already integrated through the observed clean integration head 5a8a33dc5392c3b50b1b4860c5f90230f96e9cdc remain authoritative. This plan does not ask the next session to redo them.

**Supersession boundary:** all old tasks that made @aurora/local-speech a TypeScript-owned inference/state-machine runtime, made PocketTTS-Raven the predetermined client engine, made Transformers.js or @ricky0123/vad-web production defaults, or treated mobile background wakeword as a small KWS-only follow-up are removed. Pure web still requires WebAssembly, but it will use a browser build of the shared Rust orchestration core plus a portable speech-engine build rather than a second application-level voice implementation.

**Target result:** one semantic voice runtime and one voice-turn state machine are shared across installed native surfaces and pure web; only the unavoidable microphone, playback, storage, lifecycle, and host-FFI adapters differ by platform.

**Stop condition:** repo-local implementation and unsigned packaging are complete only when every surface advertises honest capability, exactly one runtime owns capture and model inference for a session, native background turns no longer depend on a live WebView, pure web stops cleanly when browser lifecycle makes capture unreliable, and model/runtime portability is proven for the metadata-described on-demand packs. Official signed/store release claims additionally require the named emulator, browser, desktop-host, physical-device, and acoustic evidence; absence of those external environments does not disable or remove the implemented capability.

---

## 1. Executive decision

1. Build a shared Rust voice orchestration core for capture framing, resampling contracts, bounded buffers, wake/VAD/STT/TTS provider traits, model lifecycle, turn state, cancellation, redacted events, and routing decisions.
2. Compile that core natively for desktop, Android, and iOS and to WebAssembly for pure web.
3. Use platform-native audio and lifecycle adapters:
   - desktop: CPAL if its dependency/MSRV and device matrix pass;
   - Android: Kotlin foreground-service/default-assistant control plane with AudioRecord or AAudio, optionally feeding a CPAL data plane if the spike proves it;
   - iOS: Swift AVAudioSession/AVAudioEngine control and data plane unless CPAL proves equivalent lifecycle behavior;
   - pure web: getUserMedia plus AudioWorklet/Web Audio feeding the Rust/WASM core.
4. Prefer sherpa-onnx as the first portable engine-family candidate because its C++ core, C API, Rust API, Kotlin/Java API, Swift API, Android/iOS support, and Emscripten WebAssembly builds cover STT, TTS, VAD, and KWS. It is a candidate selected by Phase 4 evidence, not an unconditional dependency decision.
5. Do not write a new inference engine in Rust. Rust owns Aurora's orchestration and safety semantics. The native engine can be linked through C FFI and the browser engine can be linked or hosted through Emscripten/WASM.
6. Treat model portability as a tested property, not an ONNX assumption. A model pack is interchangeable only after its graph, operators, tokenizer, preprocessing, recurrent/cache state, output postprocessing, cancellation, and quality behavior pass both native and web gates.
7. Installed applications use the native runtime for focused push-to-talk and, where supported, background listening. Their WebViews become controllers/views and do not open a second microphone or load duplicate speech models.
8. Pure web uses the Rust/WASM runtime only while the document is eligible for foreground microphone work. Workers, service workers, AudioWorklets, and WASM do not make hidden, frozen, discarded, or suspended tabs reliable background assistants.
9. A complete background voice turn is native end to end:
   native microphone -> local KWS -> bounded pre-roll/VAD -> local or routed STT -> native typed Aurora client -> assistant response stream -> local or routed TTS -> native playback.
   No background step may require JavaScript in the WebView to wake up and generate the request.
10. Desktop with a Python sidecar and desktop without one use the same native voice runtime. With a sidecar, the native client can call the loopback Gateway and use Python services as permitted route targets. Without a sidecar, it calls a configured remote/home Gateway. The legacy Python STTCoordinator remains a mutually exclusive compatibility/rollback owner, not a concurrent microphone owner.
11. Keep the existing WebView push-to-talk implementation only as a migration bridge. The user-visible PTT control survives; its capture/segmentation/model ownership moves behind one VoiceRuntime interface. Delete installed-surface WebView capture only after native parity. Replace the pure-web implementation with the Rust/WASM path only after browser parity.
12. Keep only lightweight KWS/VAD resident during an enabled background session. Load STT and TTS lazily or retain them within measured memory/thermal budgets. This is staged residency, not duplicate inference ownership.
13. Do not ship the currently published sherpa PocketTTS pack as a product dependency: the inspected pack is English-only and its model card says non-commercial. A redistributable multilingual PocketTTS pack or an independently approved conversion is a hard release gate.
14. iOS background support means a user-started, visibly indicated audio session that may continue while the app is backgrounded. It does not mean silent perpetual restart after force quit, reboot, or OS termination. Production release remains conditional on physical-device endurance and App Review acceptance.
15. Android has two distinct modes:
   - an ordinary opt-in microphone foreground service started from a visible/user action with an ongoing notification and stop control;
   - an optional VoiceInteractionService path only when the user selects Aurora as the system assistant. The always-running service stays lightweight and hands real turns to a separate session/runtime component.

---

## 2. What this plan removes, preserves, and adds

### 2.1 Removed from the old future plan

- A TypeScript-owned @aurora/local-speech state machine and inference abstraction.
- A production architecture in which hosted web, Android WebView, iOS WKWebView, and desktop WebView each capture and run models themselves.
- PocketTTS-Raven as the predetermined cross-surface TTS engine.
- Transformers.js as the predetermined STT integration layer.
- @ricky0123/vad-web as the production VAD owner.
- A foreground WebView wakeword implementation that would later coexist with an unrelated native background implementation.
- The assumption that background work ends after native KWS and can hand the rest of the turn to a suspended WebView.
- Any design that instantiates the same STT/TTS/KWS model concurrently in native and WebView runtimes.
- Any claim that ONNX files automatically run identically in native ONNX Runtime and ONNX Runtime Web.
- Any claim that the current Raven, Candle, or sherpa PocketTTS conversion already proves production Android/iOS support for all six PocketTTS languages.

### 2.2 Preserved

- Existing Python Piper and official PocketTTS providers and their rollback path.
- Existing provider-neutral language/configuration work.
- Existing typed STT/TTS/speech contracts, permissions, redaction, generated SDK artifacts, provider readiness, and mesh route binding.
- Existing remote STT/TTS paths and user-selectable route semantics.
- Existing voice/profile import security boundaries.
- Existing local-speech benchmark harnesses, Raven provenance/conversion evidence, KWS feasibility harness, and fail-closed STT decision gates.
- Current PTT and read-aloud behavior as regression fixtures during migration.
- getAuroraSurfaceProfile as the only source of UI surface/capability truth.
- Python STTCoordinator as the existing headless/server/legacy desktop background owner.

### 2.3 Added

- Shared Rust voice core and native/WASM adapters.
- Native background request/response transport independent of WebView liveness.
- A Rust projection of authoritative Aurora DTOs and method descriptors.
- An explicit capture/model ownership lease and handoff protocol.
- Full Android and iOS lifecycle programs.
- A pure-web foreground lifecycle contract.
- Per-model native/WASM interchangeability gates.
- Cross-target signed model-pack variants.
- Installed-surface PTT migration and WebView model/capture removal.
- Background battery, privacy, policy, and physical-device release gates.

---

## 3. Preserved implementation baseline

The following work is already represented in the current integration history and becomes the foundation for this plan.

### 3.1 Completed Phase 0 baseline

- Piper behavior, streaming, cancellation, route selection, process lifecycle, and focused PTT are regression-locked.
- Redacted STT, KWS, Raven, dependency/ABI, and packaging feasibility harnesses exist under benchmarks/local-speech, tools/pockettts-raven, tools/wakeword-training, and scripts/speech_runtime_abi.
- Raven English, Portuguese, and French-24-layer candidate conversions have reproducible provenance evidence, but remain release-blocked.
- STT selection is fail-closed; incomplete external-json candidates cannot become a default.
- KWS imported-classifier parity remains absent unless the complete frontend ABI is proven.

### 3.2 Completed Phase 1 baseline

- Provider-neutral TTS boundaries, Piper adaptation, shared playback, language policy, nested configuration, legacy migration, generation, and reload behavior are implemented.
- Piper remains a supported rollback provider.
- Python voice ownership and configuration stay behind ConfigService and typed models.

### 3.3 Completed Phase 2 baseline

- Official PocketTTS is integrated on the Python server behind the provider contract.
- Voice-state validation, finite and streaming synthesis, cancellation, serialization, process mode, media import, packaging, lifecycle, and provider conformance have dedicated coverage.
- This Python path remains valid for headless/local nodes and as an explicit remote or compatibility route.

### 3.4 Completed Phase 3 baseline

- Provider-neutral speech contracts, use/manage authorization, language/voice constraints, readiness projection, route binding, generated SDK support, peer-host support, event subscription, negative security tests, and fragmentation handling are integrated.
- New native work must consume these contracts; it must not create parallel literal topics or untyped private equivalents.

### 3.5 Open findings carried forward

- No client STT engine has passed the full device/language matrix.
- Raven has useful conversion evidence but not production browser/mobile/thermal/cancellation/license evidence.
- The old trained OpenWakeWord browser frontend is not proven.
- The existing Android foreground service is a notification/control skeleton, not a capture/inference backend.
- The existing Android VoiceInteractionService is only a declaration/skeleton.
- The existing iOS plug-in reports foreground voice only and declares background voice unsupported.
- The current WebView PTT implementation owns getUserMedia, Web Audio, and MediaRecorder in assistant-view.tsx.
- The Tauri crate currently has no speech inference/audio dependency and declares Rust 1.77.2; current CPAL documentation requires Rust 1.85 for the relevant stable backends.

---

## 4. Evidence-backed feasibility conclusions

### 4.1 Rust can be shared across desktop and mobile

- Rust publishes Tier 2 targets with std support for Android and Tier 2 ARM64 targets for iOS.
- Tauri mobile plug-ins can call shared Rust through JNI on Android and C FFI on iOS even when the WebView is suspended.
- The Tauri application crate already builds cdylib/staticlib/rlib forms suitable for mobile integration.

Conclusion: the Rust orchestration core can be a real native mobile component. Kotlin and Swift still own OS lifecycle and permission integration where appropriate.

### 4.2 Rust can also run in pure web, but not as background authority

- Rust can compile the orchestration core to WebAssembly.
- sherpa-onnx and ONNX Runtime provide browser WebAssembly execution.
- Web Audio can feed PCM to WASM while the page is allowed to run.
- Hidden tabs may be frozen or discarded; discarded pages run no JavaScript, callbacks, workers, or WASM.
- When an AudioContext is suspended, MediaStream output is lost and AudioWorklet processing handlers stop.

Conclusion: pure web can share the inference/state implementation but cannot promise durable background wakeword or turns.

### 4.3 One portable engine family is plausible, not yet proven

sherpa-onnx currently provides:

- native Windows/macOS/Linux/Android/iOS builds;
- C/C++, Rust, Kotlin/Java, Swift, and JavaScript APIs;
- WebAssembly builds;
- streaming/non-streaming STT;
- PocketTTS and other TTS families;
- Silero VAD;
- open-vocabulary KWS;
- callback/cancellation surfaces.

That breadth makes it the preferred Phase 4 candidate. It does not prove every selected model pack on every Aurora target.

### 4.4 PocketTTS portability is specifically conditional

- sherpa-onnx exposes PocketTTS through Rust and other native bindings and has a browser WASM example.
- Its inspected pack uses the same multi-file ONNX graph family across examples.
- Its inspected pack is English-only.
- Its Hugging Face model card warns that the source material is non-commercial.
- Official Kyutai PocketTTS currently advertises English, French, German, Portuguese, Italian, and Spanish, but those official Python configurations are not automatically equivalent to the inspected sherpa ONNX export.

Conclusion: PocketTTS has a credible engine path, but Aurora cannot claim multilingual native/WASM interchangeability or redistribution until it reproduces and licenses exact packs.

### 4.5 Audio capture cannot literally be one implementation

The semantic pipeline can be shared, but operating systems expose different permission, lifecycle, device-route, and service APIs. A small platform adapter is unavoidable. CPAL can reduce data-plane duplication, but it does not replace:

- Android foreground-service and assistant-role rules;
- iOS AVAudioSession category, interruption, route, and background-mode handling;
- browser permission, visibility, AudioContext, and AudioWorklet behavior.

Conclusion: target one state machine and PCM contract, not one universal OS microphone file.

---

## 5. Goals, non-goals, and invariants

### 5.1 Goals

- One Aurora voice-turn state machine across Rust native and Rust/WASM builds.
- One selected capture/model owner per active session.
- Native installed-surface PTT, wakeword, VAD, STT, TTS, request transport, response handling, and playback.
- Pure-web PTT, VAD, STT, TTS, and optional focused wakeword using the same core while foreground-eligible.
- Desktop operation with a local Python sidecar, a remote Gateway without a sidecar, or a legacy Python voice owner.
- Android background sessions with explicit notification/stop and an optional default-assistant mode.
- iOS user-started background sessions only when policy and device gates pass.
- Same logical model-pack definitions across native and web with explicit target variants where required.
- Existing remote/provider route selection preserved.
- Existing PTT UX preserved during migration.
- No raw continuous audio leaves the capture device for local VAD/KWS.
- No hidden duplicate model or microphone in a suspended WebView.
- Honest product copy and capability reporting.

### 5.2 Non-goals

- A new pure-Rust neural inference framework.
- Guaranteed background wakeword in arbitrary browser tabs or PWAs.
- Silent or undisclosed mobile microphone use.
- Automatic iOS restart after force quit or OS termination.
- Making Aurora the Android default assistant without an explicit user choice.
- Replacing the Python service architecture or Python speech providers.
- Native mesh/WebRTC background transport in the first native release.
- Cloud training of wakeword or voice-clone data as part of this plan.
- Binary compatibility between unrelated Python, Raven, Candle, and sherpa voice states.
- Bundling all models into desktop, APK, IPA, or web assets.
- Advertising native devices as mesh speech providers before native provider-host transport is implemented and authorized.

### 5.3 Non-negotiable invariants

1. Exactly one CaptureOwner holds the microphone lease.
2. Exactly one RuntimeOwner performs local KWS/VAD/STT/TTS for a turn.
3. A WebView cannot be RuntimeOwner for an installed app after native cutover.
4. Runtime handoff is stop -> release -> acknowledge -> start; never overlap.
5. KWS/VAD never route raw continuous audio.
6. Every remote call uses existing typed method IDs, DTOs, authorization, redaction, and route binding.
7. Background work never relies on a WebView callback.
8. Model readiness is hash/revision/language/engine/target-specific.
9. A model is not portable merely because its filename ends in .onnx.
10. A model or voice pack without redistribution approval cannot be auto-downloaded or shipped.
11. Pure web stops capture and invalidates background capability when lifecycle eligibility is lost.
12. Native background mode is opt-in, visibly indicated, immediately stoppable, and fail-closed.
13. UI capability decisions come from getAuroraSurfaceProfile.
14. Audio/model/voice contents never appear in logs, crash reports, or telemetry.

---

## 6. Surface behavior matrix

| Surface/profile | Capture owner | Local inference owner | Background claim | Aurora request transport | Required fallback |
| --- | --- | --- | --- | --- | --- |
| Python headless/server | STTCoordinator | Python providers | Existing daemon behavior | Message bus/Gateway | Existing provider routing |
| Desktop Tauri with sidecar, native mode | Rust native runtime | Rust native engine | Yes while native app/agent is running; sleep suspends | Loopback Gateway HTTP/SSE first | Permitted Python/remote providers |
| Desktop Tauri with sidecar, legacy mode | STTCoordinator | Python providers | Existing daemon behavior | Existing sidecar path | Native mode disabled and mic lease released |
| Desktop Tauri without sidecar | Rust native runtime | Rust native engine | Yes while native app/agent is running | Configured remote/home Gateway HTTP/SSE | Honest unavailable state if no route |
| Desktop hosted browser | Web Audio adapter | Rust/WASM core + web engine | No durable background | Existing web SDK/Gateway | Existing remote route |
| Android installed app | Kotlin native service -> Rust | Rust native engine | Opt-in foreground microphone service | Native Gateway HTTP/SSE first | Foreground PTT/remote route |
| Android selected system assistant | Lightweight VoiceInteractionService -> session/runtime | Rust native engine | Hotword-capable under system role | Native Gateway transport | Ordinary FGS/PTT paths |
| iOS installed app | Swift AVAudioSession/AVAudioEngine -> Rust | Rust native engine | Conditional user-started audio session only | Native Gateway HTTP/SSE first | Foreground PTT/App Intents |
| Pure web/PWA | getUserMedia/AudioWorklet | Rust/WASM core + web engine | Foreground/focus eligible only | Existing web SDK/Gateway | Remote methods or unavailable state |
| Tauri WebView after native cutover | None; controller only | None | UI may be absent/suspended | Tauri commands/events only | Native status snapshot on reconnect |

### 6.1 Desktop mode selection

- auto prefers native voice when the selected native engine and packs are ready.
- native forces Rust voice ownership and refuses to start if the native runtime is unavailable.
- python selects the legacy STTCoordinator/Python providers and stops/releases native capture.
- remote disables local model execution but still allows native PTT capture when explicitly configured.
- disabled releases all capture/model resources.

These are internal settings. Product UI must describe outcomes such as “On this device,” “Home device,” “Only while the app is open,” or “Continue listening in the background,” not implementation terms.

### 6.2 No-sidecar desktop boundary

Local KWS/VAD/STT/TTS can run without Python. Aurora's LLM/tools still require an eligible Gateway unless separately implemented. If no Gateway is available:

- do not wake a hidden WebView;
- do not retain or later auto-send a transcript;
- provide a native audible/product-safe connection failure;
- discard ephemeral transcript/audio at the configured timeout unless the user explicitly saves it.

---

## 7. Target architecture

### 7.1 Runtime layers

    Platform audio/lifecycle adapter
                  |
                  v
        Aurora Rust voice core
        - capture lease
        - PCM framing/resampling contract
        - pre-roll/ring buffers
        - state machine/cancellation
        - KWS/VAD/STT/TTS traits
        - model/voice pack lifecycle
        - turn routing and redacted events
          |                    |
          v                    v
    Native engine adapter   Web engine host
    sherpa C API/FFI        sherpa Emscripten/WASM
          |                    |
          +----------+---------+
                     v
             Native/Web transport
             typed Aurora DTOs

### 7.2 Recommended repository layout

- rust/Cargo.toml — isolated Rust workspace; do not turn the Python repository root into an implicit Cargo package.
- rust/crates/aurora-contracts — generated serde DTOs, method descriptors, redaction metadata, and fixture conformance.
- rust/crates/aurora-voice-core — no Tauri/Kotlin/Swift/browser dependencies.
- rust/crates/aurora-voice-engine — provider traits and model capability types.
- rust/crates/aurora-voice-sherpa — pinned native C API adapter and web-host ABI.
- rust/crates/aurora-voice-native — native model store, downloader, transport, and desktop runtime.
- rust/crates/aurora-voice-wasm — wasm-bindgen/Emscripten-facing core exports.
- rust/crates/aurora-voice-testkit — golden PCM/model/event fixtures, fake clock/audio/engine/transport.
- packages/aurora-voice-web — generated/thin browser loader, AudioWorklet host, and WASM assets only; no second state machine.
- apps/aurora-tauri/src-tauri/src/voice — Tauri commands/events, desktop lifecycle, and native runtime installation.
- apps/aurora-tauri/src-tauri/android/... — Kotlin service, role, permission, notification, audio, and JNI adapters.
- apps/aurora-tauri/src-tauri/ios/AuroraNativePlugin/... — Swift audio/session/App Intent and C FFI adapters.
- tools/voice-runtime — pinned source/artifact fetch, hashes, CMake/NDK/Xcode/Emscripten builds, model-pack inspection, and license inventory.
- tests/fixtures/local_speech/runtime — golden PCM, text, expected state transitions, and parity metadata.

Final names may change during Phase 4 only if an ADR records why. Boundaries may not collapse into assistant-view.tsx or the Tauri lib.rs monolith.

### 7.3 Core interfaces

AudioInput:

- start(lease, requested_format)
- stop(reason)
- frames() -> PcmFrame
- current_route()
- interruption stream

SpeechEngine:

- load/unload task packs
- warm/cold readiness
- KWS stream creation/reset
- VAD stream creation/reset
- STT finite/streaming session
- TTS generation with chunk callback
- cancellation token
- capability and resource report

ModelStore:

- inspect quota/state
- stage/resume/download
- verify hash/signature/license metadata
- atomic activate/rollback/remove
- open immutable pack files

SpeechTransport:

- invoke typed finite method
- open typed event stream
- cancel request/session
- refresh auth/readiness
- map errors to redacted product states

RuntimeEventSink:

- redacted state snapshot
- level/waveform data with no reconstructable audio retention
- partial/final transcript only when product policy permits
- wake/turn/playback lifecycle
- capability/readiness/progress
- interruption/recovery/fault

### 7.4 PCM contract

- Canonical processing format: 16 kHz, mono, finite normalized f32 or i16 selected once in the core ABI.
- PcmFrame includes monotonic timestamp, sample count, sequence, discontinuity flag, source route revision, and capture generation.
- Resampling occurs once at the platform/core boundary.
- Audio callbacks only copy into a bounded lock-free or wait-free buffer; they never allocate large objects, download, tokenize, infer, log, or call the network.
- Pre-roll is bounded by configuration and erased after turn completion/cancellation.
- Every discontinuity resets KWS/VAD recurrent state and prevents mixed-route utterances.

### 7.5 Engine packaging

- Pin an exact sherpa-onnx release/commit and exact ONNX Runtime revision.
- Prefer verified source builds or hash-pinned upstream binaries.
- Do not allow a Cargo build script to fetch mutable native libraries from the network.
- Use SHERPA_ONNX_LIB_DIR or an Aurora-owned sys binding against staged verified libraries.
- Generate and check C bindings deterministically.
- Android packages contain only selected ABI libraries, including 16 KB page-size compatibility.
- iOS uses a reproducible XCFramework/static-library set for device and simulator.
- Web uses a reproducible Emscripten build with explicit SIMD/thread variants.
- Every binary includes NOTICE/license inventory and an SBOM entry.

### 7.6 Web linking decision spike

Phase 4 must choose and document one of:

1. preferred: one Emscripten-linked module containing the Rust core and sherpa native engine; or
2. fallback: Rust wasm32 core plus a separate sherpa Emscripten module joined by a narrow generated host ABI.

The fallback is acceptable because application state/orchestration remains in Rust and the JS host only moves typed buffers/calls. It must not grow into a second voice state machine.

---

## 8. Capture, model, and session ownership

### 8.1 Capture lease

Create a generation-scoped VoiceCaptureLease with:

- owner: python, native, web, or none;
- surface/profile;
- device/route identity;
- start reason: ptt, foreground wake, background session, assistant role;
- generation and monotonic creation time;
- visibility/background eligibility;
- consent revision;
- heartbeat/health;
- stop deadline.

Desktop Python/native handoff additionally uses a cross-process singleton guard and the existing typed AudioSession lifecycle where applicable. A stale guard can be recovered only after proving the prior owner is dead and the microphone handle is released.

### 8.2 Runtime handoff

1. New owner requests handoff.
2. Current owner stops capture and cancels inference.
3. Current owner releases device, buffers, and session generation.
4. Current owner acknowledges stopped.
5. Coordinator increments generation.
6. New owner starts.
7. Late frames/events from the prior generation are rejected.

Timeout means fail closed. Never “best effort” start a second owner.

### 8.3 Model residency

- KWS and VAD may remain resident only during an enabled listening session.
- STT loads on wake/PTT or stays warm only within the device-class budget.
- TTS loads when a response is expected or stays warm within budget.
- Voice embeddings may remain encrypted/durable if the user saved them.
- A WebView never mirrors native model residency.
- Native background service survives UI closure; UI reconnect receives only a current redacted snapshot.
- Low-memory callbacks unload TTS first, then STT; KWS/VAD are retained only if the OS still permits listening.

---

## 9. Model and engine compatibility matrix

Status labels:

- proven: upstream demonstrates the exact task/runtime class;
- plausible: engine/platform exists but Aurora must prove the exact model/target;
- blocked: known licensing, coverage, packaging, or parity failure;
- legacy: retained only for Python/server/rollback.

| Task/candidate | Desktop native | Android native | iOS native | Browser WASM | Current disposition |
| --- | --- | --- | --- | --- | --- |
| sherpa-onnx engine family | Proven generally | Proven generally | Proven generally | Proven generally | Preferred Phase 4 engine family |
| sherpa PocketTTS inspected English pack | Proven API/example | Plausible; exact app build required | Plausible; exact device build required | Proven demo/API | Blocked from product distribution by English-only/non-commercial pack |
| PocketTTS-Raven | Proven desktop/native and browser candidate | Unproven production packaging/lifecycle | Unproven production packaging/lifecycle | Proven candidate | Benchmark/reference fallback only |
| Candle pure-Rust PocketTTS | Native candidate | Unproven; dependency audit required | Unproven; dependency audit required | Experimental upstream | Not primary; revisit only if sherpa fails |
| official Python PocketTTS | Proven | Not applicable | Not applicable | Not applicable | Existing Python/server provider |
| sherpa Moonshine v2 STT | Proven engine/model family | Upstream Android examples | Plausible exact iOS pack | Upstream WASM/JS support | Primary short-form STT bakeoff candidate by language |
| sherpa Zipformer/CTC STT | Proven | Proven examples | Plausible exact pack | Proven examples | Streaming/size candidate by language |
| sherpa Whisper STT | Proven | Plausible performance | Plausible performance | Plausible performance | Multilingual fallback candidate |
| Transformers.js STT | Web only | WebView only | WebView only | Proven web | Diagnostic baseline, not installed-surface architecture |
| whisper.cpp WASM/native | Proven | Plausible | Plausible | Proven | Diagnostic/fallback candidate if sherpa model gate fails |
| Silero VAD through sherpa | Proven | Proven example/APK | Plausible exact iOS integration | Proven example | Preferred VAD candidate |
| sherpa open-vocabulary KWS | Proven C/Rust API | Proven Android app | Plausible C/Swift integration | Build support exists; exact browser path gate required | Preferred KWS candidate if FAR/FRR/battery pass |
| OpenWakeWord Python frontend/classifier | Legacy proven | Not interchangeable | Not interchangeable | Not interchangeable without full frontend parity | Python legacy or separately versioned imported-pack ABI |

### 9.1 TTS decision

Primary architecture candidate:

- sherpa-onnx PocketTTS through one engine family.

Release requires:

- redistributable production rights for code, graphs, tokenizer, voices, and test/reference assets;
- exact English/French/German/Portuguese/Italian/Spanish pack inventory or honest per-language absence;
- native desktop, Android ARM64, iOS ARM64, and browser WASM builds;
- same-language tokenizer/preprocessing parity;
- streaming chunk callback and cancellation without stale playback;
- voice-embedding cache/profile compatibility tests;
- target-device RTF, time-to-first-audio, memory, thermal, and quality gates.

If PocketTTS fails:

- retain Python PocketTTS where licensed/configured;
- select another sherpa TTS family for native/web base functionality;
- keep local PocketTTS unavailable rather than distributing an unapproved pack;
- do not revive Raven as default without passing the same gates.

### 9.2 STT decision

Do not require one STT model for every language/device class. Require one engine ABI and signed packs.

Candidate order:

1. Moonshine v2 language-specific packs for low-latency short turns.
2. Streaming Zipformer/CTC packs where language/quality is adequate.
3. sherpa Whisper multilingual pack where broader language detection is required.
4. whisper.cpp only if sherpa cannot meet a required pack/runtime combination.

Selection is per language and device class. A pack can share exact files across native/WASM only after parity. Otherwise the manifest carries target variants under one semantic model ID.

### 9.3 VAD decision

Use Silero VAD through the selected engine if:

- the same 16 kHz model and recurrent-state reset semantics pass native/WASM tests;
- thresholds, min/max speech, silence, and flush semantics are controlled by the Rust core;
- end-of-speech latency and false segmentation pass the Aurora corpus;
- iOS physical-device integration passes.

The old browser-specific VAD dependency is not a production fallback.

### 9.4 KWS decision

Use sherpa open-vocabulary KWS if:

- the exact selected small transducer pack builds on all promised native targets and browser WASM;
- phrase tokenization is reproducible offline;
- per-language phrase support is truthful;
- near/far/accent/noise FAR/FRR gates pass;
- locked/background battery and thermal gates pass;
- reset, interruption, and TTS-echo behavior pass;
- imported trained classifiers remain a separately versioned capability unless the full OpenWakeWord frontend ABI is reproduced.

### 9.5 No false interchangeability

The following are insufficient proof:

- both artifacts are ONNX;
- both engines use ONNX Runtime;
- one desktop example works;
- one browser demo produces audio;
- Kotlin/Swift bindings compile;
- tokenizer filenames match;
- outputs “sound okay” once.

---

## 10. Native/WASM interchangeability protocol

Every candidate ModelPackVariant must pass the following before its manifest can set interoperable=true.

### 10.1 Static compatibility

- exact engine source revision and build flags;
- exact model file SHA-256 values;
- ONNX opset and required operator inventory;
- native/mobile/web operator-kernel availability;
- tokenizer/vocabulary/normalizer hashes;
- preprocessing and postprocessing ABI revision;
- sample rate/channel/frame/window shape;
- recurrent/cache state names, shapes, and reset rules;
- quantization type and provider constraints;
- language and locale coverage;
- license and distribution rights;
- model/voice-state compatibility group.

### 10.2 Golden dynamic compatibility

VAD:

- frame scores within declared numeric tolerance;
- identical speech boundaries within one frame;
- identical flush/reset/discontinuity behavior.

KWS:

- score traces within tolerance;
- identical trigger/non-trigger decisions on fixed thresholds;
- identical cooldown/reset behavior;
- corpus-level FAR/FRR within allowed delta.

STT:

- normalized transcripts and timestamps compared on the same corpus;
- WER/CER bucket deltas bounded;
- fixed-language and auto-language behavior compared separately;
- partial/final ordering and cancellation equivalent.

TTS:

- same seed/config/reference audio where supported;
- sample rate and stream ordering identical;
- duration, intelligibility, pronunciation, speaker similarity, clipping, EOS, and hallucination thresholds;
- no byte-identical waveform requirement across floating-point providers;
- cancellation produces no post-cancel audible chunks.

### 10.3 Target matrix

At minimum:

- Linux x86_64 desktop native;
- Windows x86_64 desktop native;
- macOS ARM64 desktop native;
- Android ARM64 physical device plus x86_64 emulator build;
- iOS ARM64 physical device plus simulator build;
- Chromium desktop WASM;
- Firefox desktop WASM;
- Safari macOS WASM;
- Chrome Android pure-web WASM;
- Mobile Safari pure-web WASM.

An emulator/simulator proves integration and lifecycle shape, not microphone acoustics, battery, thermal, or App/Play policy behavior.

### 10.4 Variant semantics

A logical pack may contain:

- native-cpu variant;
- android-arm64 variant;
- ios-arm64 variant;
- wasm-simd variant;
- wasm-simd-threads variant.

Variants may use different packaging or reduced operator builds. If model/tokenizer/pre/post behavior differs materially, they are separate compatibility groups even when the UI presents one voice/language choice.

---

## 11. Model packs, delivery, and storage

### 11.1 Signed manifest fields

Each pack and variant records:

- semantic pack ID and version;
- task: KWS, VAD, STT, TTS, voice embedding, tokenizer, frontend;
- engine family/revision/build ABI;
- source URL/revision and provenance;
- license identifier, full license URL/text hash, commercial/redistribution decision, attribution;
- languages/locales and fixed/auto support;
- target OS/architecture/runtime;
- required browser features;
- model files, sizes, hashes, compression, and install order;
- tokenizer/pre/post ABI;
- sample/frame/cache shapes;
- streaming/cancellation capabilities;
- memory/CPU/RTF/device-class gates;
- compatibility group;
- voice-state compatibility group;
- minimum Aurora/runtime version;
- signature, revocation, supersession, and rollback metadata.

### 11.2 Storage

Desktop:

- app data/Application Support model directory;
- durable across upgrades;
- excluded from thin-client artifact checks only as downloaded runtime data;
- atomic version directories and active pointer.

Android:

- app-private no-backup durable directory;
- per-ABI native library is bundled, model weights are downloaded;
- WorkManager may download models, but never owns continuous capture;
- metered-network and storage controls.

iOS:

- Application Support;
- excluded from backup when redistributable/redownloadable;
- file-protection class selected by privacy requirement;
- no download execution that pretends a suspended app is active.

Web:

- OPFS preferred, IndexedDB fallback;
- persistent-storage request and quota reporting;
- no permanence claim in private/ephemeral contexts;
- resumable verified downloads;
- explicit recovery after eviction.

### 11.3 Install transaction

1. Resolve eligible variant.
2. Confirm license/capability/device/storage/network policy.
3. Download to staging with resume.
4. Verify declared byte length and hashes while streaming.
5. Verify signature/manifest revision.
6. Inspect expected files/operators/tokenizer metadata.
7. Run bounded load/smoke.
8. Atomically activate.
9. Retain one known-good rollback within quota.
10. Withdraw readiness immediately on corruption/revocation.

### 11.4 Bundle policy

- No model weights in hosted web bundles.
- No downloaded STT/TTS/KWS weights in APK/IPA/desktop installer unless a later explicit packaging decision passes license and size gates.
- The tiny VAD/KWS pack may be considered for bundling only through a separate recorded decision; default remains downloadable.
- Artifact scanners reject unexpected ONNX, ORT, GGML, safetensors, voice embeddings, training assets, and unexplained large binary payloads.

---

## 12. Unified voice state machine and PTT migration

### 12.1 States

- disabled
- provisioning
- unavailable
- idle
- arming
- listening_for_wake
- wake_detected
- capturing_utterance
- transcribing
- dispatching
- awaiting_response
- speaking
- interrupted
- suspended
- recovering
- stopping
- faulted

Every transition carries generation, reason, surface, route revision, and redacted timestamps.

### 12.2 PTT

PTT is not deleted as a product capability. It becomes a trigger into the same runtime:

1. User presses PTT.
2. Runtime acquires capture lease.
3. It bypasses KWS and enters capturing_utterance.
4. VAD/end gesture closes the utterance.
5. STT/routing/request/TTS use the same turn executor as wakeword.
6. Release/cancel uses the same cleanup path.

### 12.3 Migration sequence

1. Keep current assistant-view.tsx PTT tests as the behavior lock.
2. Introduce a VoiceRuntime client interface with fake implementation.
3. Route installed desktop PTT to native capture first.
4. Route Android and iOS PTT to native capture.
5. Route pure web PTT to Rust/WASM plus Web Audio.
6. Prove waveform, stop, cancel, permission, route, and result parity.
7. Remove getUserMedia/MediaRecorder ownership from installed-surface paths.
8. Remove the old browser state machine after Rust/WASM parity; retain only the thin Web Audio adapter.

### 12.4 Wakeword and speaking interaction

- Base release suspends KWS while Aurora TTS is playing to avoid self-trigger.
- PTT and explicit stop remain available during playback.
- Acoustic echo cancellation/barge-in wakeword is a later opt-in only after per-device echo corpus evidence.
- A route change or interruption resets KWS/VAD state and bounded pre-roll.

### 12.5 UI contract

The UI receives:

- current enabled/readiness/listening/speaking state;
- download progress;
- product-safe permission/interruption/error;
- non-reconstructable level/waveform samples;
- transcript/response only under existing privacy rules.

The UI never owns:

- the background service;
- raw audio retention;
- native credentials;
- model file paths;
- inference thread state;
- OS audio session restoration.

---

## 13. Background turn execution and native transport

### 13.1 Why transport must be native

Background capture without native request generation is incomplete. A suspended WebView cannot reliably:

- finalize STT;
- select a provider;
- attach route/auth metadata;
- invoke the assistant;
- consume response events;
- run or request TTS;
- play the result.

Therefore installed surfaces require a native VoiceTurnExecutor.

### 13.2 Native turn flow

1. Local KWS triggers and opens a bounded utterance session.
2. Local VAD captures through end-of-speech.
3. Route policy selects local native STT or an eligible existing remote Transcription.Transcribe route.
4. The final transcript is submitted through the same authoritative assistant request used by the UI.
5. Native transport consumes typed SSE/finite responses.
6. Route policy selects local native TTS or an eligible existing TTS route.
7. Native playback emits ordered lifecycle events.
8. Cancellation propagates to inference, network, queues, and playback.
9. UI may attach/detach at any point without owning the turn.

### 13.3 Initial transport

Use native HTTP plus SSE first because the Tauri Rust layer already has request and event-stream plumbing and the Gateway exposes generated HTTP methods and /api/events/stream.

Requirements:

- generated method paths and DTOs;
- existing bearer/device credentials from approved secure storage;
- request IDs, idempotency, timeout, cancellation, redaction;
- Phase 3 language/voice/readiness/explicit-target semantics;
- loopback sidecar health/identity checks;
- TLS/pinning policy for remote Gateway as already defined by Aurora;
- bounded response sizes and stream reconnection;
- no raw audio route unless an existing consent-scoped typed method explicitly requires it.

### 13.4 Rust contract projection

Add a deterministic allowlisted Rust generator beside existing backend inventory/Zod generation:

- source: authoritative Pydantic/JSON Schema method inventory;
- output: serde DTOs, method IDs/paths/types, permissions, payload limits, redaction metadata;
- no handwritten literal bus topics;
- no separate Rust-only wire contract;
- conformance fixtures parsed by Python, Zod, and Rust;
- second-run no-diff check in CI.

### 13.5 Native WebRTC/mesh

Native mesh/WebRTC background parity is a later subphase because it requires protocol, fragmentation, identity, lease, encryption, cancellation, and provider-host compatibility beyond simple audio inference.

Initial rule:

- if an eligible HTTP/SSE Gateway route exists, background turns may proceed;
- if the user's only route requires a WebView-owned peer connection, background mode reports unavailable;
- do not silently wake or depend on the WebView;
- add native WebRTC only after a dedicated protocol conformance spike passes existing SDK/Python vectors.

### 13.6 Native provider hosting

Advertising the device's local STT/TTS to other peers is not required for the first native background release. Add it only after native transport can:

- publish recipient-specific method projections;
- maintain provider leases/readiness revisions;
- enforce use/manage authorization;
- handle fragmentation/subscriptions/cancellation;
- withdraw readiness on background/runtime loss.

---

## 14. Platform implementation programs

### 14.1 Desktop native

Responsibilities:

- CPAL or selected desktop audio backend;
- tray/background-agent lifetime and opt-in autostart;
- native microphone permission and device selection;
- sleep/wake, suspend/resume, hotplug, Bluetooth/headset, sample-rate change;
- native model store and downloader;
- native HTTP/SSE client;
- native playback and cancellation;
- sidecar-present and sidecar-absent profiles;
- Python/native lease handoff.

Desktop local with sidecar:

- native voice is the new preferred owner after release gates;
- sidecar still supplies orchestrator/tools and can remain a remote speech target;
- legacy Python voice remains selectable during rollout;
- never start Python coordinator capture and native capture together.

Desktop thin/no-sidecar:

- local speech models work natively;
- remote/home Gateway is required for assistant intelligence;
- thin-client bundle scanners must allow the Rust speech library but reject Python and downloaded models.

Lifecycle tests:

- window hidden/closed to tray;
- app quit;
- OS sleep/hibernate and resume;
- sidecar restart;
- network loss/recovery;
- mic unplug/replug;
- permission revocation;
- two Aurora instances;
- runtime mode switch;
- crash/stale lease recovery.

### 14.2 Android ordinary background session

Use the existing AuroraVoiceForegroundService as the control-plane home, then add real capture/runtime behavior.

Requirements:

- RECORD_AUDIO and foregroundServiceType=microphone;
- start from a visible/user-initiated state as required by Android;
- immediate ongoing notification with listening state and Stop action;
- Kotlin coroutine/thread ownership outside the UI/main thread;
- AudioRecord/AAudio capture or a proven CPAL data plane;
- JNI into the Rust core;
- native model/credential storage;
- process-death and service-restart policy;
- task removal, screen lock, Doze, battery saver, audio focus, call, alarm, Bluetooth, wired route, low-memory, permission-revocation handling;
- no automatic microphone restart after reboot unless a current platform exemption and explicit product decision support it;
- one-tap stop from notification and app.

Android emulator:

- compile/install;
- service/notification/permission/intent lifecycle;
- process kill/restart;
- foreground/background transitions;
- x86_64 engine/model smoke where supported.

Physical Android:

- acoustic accuracy;
- ARM64 build;
- 8-hour locked-screen endurance;
- battery/thermal;
- Bluetooth/call interruptions;
- OEM battery-management behavior;
- 16 KB page-size and Play artifact checks.

### 14.3 Android default-assistant mode

Use the existing VoiceInteractionService declaration only after:

- role qualification and user selection pass;
- service remains lightweight;
- KWS-only resident work is measured;
- heavy STT/transport/TTS runs in the associated session/runtime process;
- ordinary foreground-service mode remains available.

The system-selected service can be kept running for hotwording, but Aurora must not use that as permission to hide capture state or perform heavyweight work in the always-running component.

### 14.4 iOS foreground native

Implement before background:

- AVAudioSession playAndRecord/voice-chat decision;
- AVAudioEngine capture;
- Swift -> Rust C FFI;
- route/interruption/media-services reset handling;
- native model store/downloader;
- native transport and playback;
- PTT parity;
- simulator integration plus physical acoustic tests.

### 14.5 iOS user-started background session

Only after foreground passes:

- add the audio UIBackgroundModes capability;
- user explicitly starts the listening session while foregrounded;
- always provide the system/product recording indication and immediate stop;
- maintain AVAudioSession while the session is legitimate and permitted;
- handle calls, Siri, alarms, route changes, lock, low-power mode, media-services reset, memory pressure, and app background/foreground;
- stop honestly when the OS terminates or suspends the session;
- do not use silent audio, timers, location, push, or other keep-alive tricks;
- retain App Intents/Shortcuts/foreground PTT fallback.

Release requires:

- physical-device endurance;
- privacy review;
- App Review-compatible product description;
- successful store review or explicit distribution-policy acceptance.

If the gate fails, supportsBackgroundVoice remains false on iOS and foreground native support ships independently.

### 14.6 Pure web

Requirements:

- user gesture before microphone/AudioContext start;
- getUserMedia and AudioWorklet/Web Audio adapter;
- Rust/WASM core and selected web engine;
- worker isolation so inference never blocks rendering;
- COOP/COEP audit if threads/SharedArrayBuffer are used;
- single-thread/SIMD fallback where supported;
- OPFS/IndexedDB store;
- visibility/page lifecycle integration.

On hidden, freeze preparation, pagehide, AudioContext suspension, track end, permission loss, or device removal:

- stop capture;
- cancel turn/inference;
- release tracks;
- clear pre-roll;
- mark focused wakeword unavailable;
- require an explicit user action to resume where browser policy requires it.

Service workers and PWA installation do not change this contract.

### 14.7 Installed WebViews

After cutover:

- do not request microphone permission from the WebView;
- do not instantiate the web model store or engine;
- call bounded Tauri plug-in commands;
- subscribe to native redacted events;
- query a full state snapshot on reconnect;
- tolerate suspension/termination without affecting the native turn.

---

## 15. Configuration, capability, and routing plan

### 15.1 Central surface profile

Extend packages/aurora-ui/src/platform-surface.ts first with truthful flags such as:

- voiceRuntimeOwner;
- captureOwner;
- supportsNativeVoiceRuntime;
- supportsFocusedVoice;
- supportsBackgroundVoiceSession;
- requiresUserInitiatedBackgroundStart;
- supportsSystemAssistantRole;
- supportsWebVoiceRuntime;
- backgroundTransportAvailable;
- canHostSpeechProvider.

Pages/components consume these flags. No component infers capability from Tauri presence, user agent, WebRTC, or transport alone.

### 15.2 Local settings

Local installed/web settings include:

- runtime policy: auto/on-this-device/other-device/off;
- background listening: off/user-session/system-assistant where available;
- PTT behavior;
- primary/voice language;
- selected KWS phrase/profile;
- local model storage/network policy;
- permitted microphone/device;
- voice profile;
- route selection inherited from existing speech policy.

Python server settings remain in ConfigService. Installed-surface local runtime settings use the existing durable local settings boundary and are not injected into server config.

### 15.3 Readiness

Readiness includes:

- runtime owner/generation;
- capture permission and OS eligibility;
- transport/auth availability;
- exact engine/model/variant revision;
- language/voice capability;
- model store integrity;
- memory/thermal/device-class eligibility;
- background-mode eligibility.

Readiness withdrawal is immediate and revisioned.

### 15.4 Existing typed contracts

Reuse:

- Transcription.Transcribe and STT responses;
- TTS finite/streaming/playback/profile methods;
- AudioSession consent/lifecycle contracts;
- assistant request/result/event contracts;
- provider readiness and route binding.

If a new status/event is necessary:

1. add typed constants and Pydantic IO under app/shared/contracts/models;
2. register with method_contract and correct exposure/method_type/permissions;
3. route only through bus/SDK/Gateway boundaries;
4. regenerate Zod and Rust projections;
5. prove redaction and route behavior;
6. never add a literal topic.

### 15.5 Routing

- Local native execution is a route candidate.
- Remote Python/peer methods remain candidates.
- Language, voice, readiness, permission, privacy, and capacity gates from Phase 3 still apply.
- Explicit named targets never silently escape.
- VAD/KWS remain local-only and are never provider methods.
- Background mode requires a native-capable transport before arming.

---

## 16. Privacy, security, policy, and product copy

### 16.1 Microphone and audio

- Explicit opt-in and revocable consent.
- Native/system recording indicator plus product state.
- Ongoing Android notification.
- Bounded in-memory pre-roll only.
- No raw continuous audio telemetry.
- No background clone capture.
- No audio in logs/crash reports.
- Stop action must work without opening the UI.

### 16.2 Credentials and transport

- Reuse approved Keychain/Keystore/secure Tauri storage.
- WebView never receives long-lived native background credentials.
- Native commands have narrow Tauri permissions/capabilities.
- Validate URLs, target policy, payload size, TLS, and response type.
- Redact tokens, transcripts, clone data, model paths, and internal route details.

### 16.3 Models and voices

- Signed manifests and immutable hashes.
- License review for engine, runtime, graphs, tokenizers, voices, and reference samples.
- Voice-clone consent, source provenance, deletion, export, and compatibility metadata.
- No automatic peer synchronization of raw clone samples or embeddings.
- Secure deletion is best-effort per filesystem; product copy must not overclaim.

### 16.4 Product copy

Production UI states only:

- what is happening;
- what is affected;
- whether listening is active;
- whether the app must remain open;
- what the user can do next;
- a non-sensitive reference ID if needed.

It must not expose runtime, sidecar, WASM, ONNX, model graph, transport, schema, contract, proof, test, or implementation vocabulary.

### 16.5 Store policy

- Android FGS and assistant role reviewed independently.
- iOS background microphone reviewed independently.
- Pure web never advertises background listening.
- Capability flags change only after shipping implementation and evidence exist.

---

## 17. Revised implementation phases

Phases 0–3 below are preserved/integrated baseline. New implementation starts at Phase 4.

### Phase 0 — Completed evidence and regression baseline

Status: preserved.

Do not rerun broad discovery unless a pinned dependency/model revision changes. Reuse the current benchmark and regression harnesses.

### Phase 1 — Completed Python provider/configuration boundary

Status: preserved.

Do not replace or refactor this work as part of the native runtime unless a targeted compatibility defect is found.

### Phase 2 — Completed official Python PocketTTS provider

Status: preserved.

Keep as server/remote/rollback capability.

### Phase 3 — Completed speech contracts/SDK/routing/security

Status: preserved.

Generate native consumers from it; do not fork the contract.

### Phase 4 — Architecture freeze and portability gates

Goal: prove the proposed engine/toolchain/audio/transport foundations before production integration.

Work:

- Add a written ADR under .omx/plans or docs only after implementation begins.
- Pin sherpa-onnx, ONNX Runtime, model candidates, source archives, and hashes.
- Audit Apache/MIT/third-party/model/voice licenses.
- Prove hermetic native desktop builds.
- Prove Android ARM64/x86_64 native library builds and 16 KB pages.
- Prove iOS device/simulator library or XCFramework builds.
- Prove TTS/STT/VAD/KWS Emscripten builds.
- Run the same candidate pack through native and browser APIs.
- Prove Rust wrapper/callback/cancellation.
- Decide one-module versus two-module web linking.
- Resolve Rust 1.77.2 versus CPAL/sherpa/dependency MSRV:
  - preferred: upgrade Tauri Rust toolchain/rust-version after the complete build matrix;
  - alternative: pin a maintained compatible audio version only after security/license review.
- Spike desktop CPAL.
- Spike Android AudioRecord/AAudio -> Rust and CPAL alternative.
- Spike iOS AVAudioEngine -> Rust and CPAL alternative.
- Spike native HTTP/SSE request from a background-owned runtime using generated fixture DTOs.
- Update existing STT/KWS harness candidate definitions to test sherpa native and WASM, not Transformers.js-only paths.
- Re-evaluate Raven and Candle only as comparison candidates.
- Record exact blockers instead of filling missing evidence with fixture data.

Exit gate:

- one selected engine integration shape;
- one selected audio approach per platform;
- one selected Rust/web linking shape;
- cross-compilation succeeds;
- native callback/cancel works;
- browser demo works without UI blocking;
- at least VAD plus one STT candidate pass native/WASM golden parity;
- PocketTTS license/language state is explicitly pass or blocked;
- no unresolved ABI/MSRV/license issue is hidden.

Hard stop:

- if no portable engine can cover required tasks, keep one Rust core but allow task-specific engine adapters; do not write a full new inference engine.

### Phase 5 — Rust workspace, generated contracts, model store, and core state machine

Goal: implement engine-independent production foundations.

Work:

- Create rust workspace/crates from section 7.
- Implement PcmFrame, discontinuity, bounded buffers, fake clock/audio, and cancellation.
- Implement capture/runtime ownership lease and generation filtering.
- Implement the state machine and transition property tests.
- Implement task provider traits.
- Implement signed pack schema, variant selection, atomic store, rollback, revocation, and resource budgets.
- Implement native downloader/store.
- Implement web downloader/store host.
- Add deterministic Rust contract generation from the existing backend inventory.
- Add Python/Zod/Rust cross-parser fixtures.
- Add native HTTP/SSE transport interface with fake transport.
- Add redacted event/snapshot API.
- Add no-raw-audio logging tests.

Likely files:

- rust/**
- scripts/generate_backend_inventory.py
- new deterministic Rust generator under scripts/
- tests/fixtures/local_speech/runtime/**
- root/package workspace scripts only through the integration owner

Exit gate:

- cargo fmt/clippy/test green;
- wasm core unit tests green;
- contract generation second run is clean;
- property tests prove no overlapping owner/generation;
- model install interruption/corruption/revocation tests green;
- fake end-to-end PTT and wake turns complete with UI detached.

### Phase 6 — Portable engine adapters and production model bakeoff

Goal: integrate real KWS/VAD/STT/TTS and select shippable packs.

Work:

- Implement native sherpa adapter through pinned C/Rust API.
- Implement web sherpa host ABI.
- Integrate Silero VAD first.
- Integrate KWS candidate and phrase/token assets.
- Integrate STT candidates by language/device class.
- Integrate PocketTTS candidate only if license/provenance permits test distribution.
- Implement TTS chunking, voice embedding cache, seed/config, and cancellation.
- Run the full interchangeability protocol.
- Produce signed candidate manifests.
- Measure desktop/browser/mobile memory, latency, CPU, thermal, battery.
- Select fallback TTS if PocketTTS remains blocked.
- Keep unavailable capabilities false.

Exit gate:

- selected VAD pack;
- selected KWS pack/languages or explicit absence;
- selected STT packs by language/device class;
- selected TTS pack/voices or explicit PocketTTS block/fallback;
- all advertised native/WASM variants pass parity and license gates;
- no stale audio after cancellation;
- no release manifest references mutable/unapproved assets.

### Phase 7 — Pure-web Rust/WASM runtime and PTT cutover

Goal: replace the old browser voice state machine while keeping honest foreground-only behavior.

Work:

- Build packages/aurora-voice-web as thin loader/AudioWorklet host.
- Wire getUserMedia/AudioWorklet PCM to Rust/WASM.
- Keep inference off the render thread.
- Add OPFS/IndexedDB pack install.
- Add browser lifecycle shutdown.
- Adapt VoiceRuntime UI client.
- Cut pure-web PTT to Rust/WASM after parity.
- Add optional focused wakeword only if KWS/browser gates pass.
- Preserve existing remote STT/TTS route selection.
- Remove old browser-specific VAD/STT/TTS state ownership.
- Add production-string/capability tests.

Exit gate:

- Chrome/Firefox/Safari desktop PTT;
- Chrome Android/Mobile Safari foreground PTT;
- page-hidden/frozen preparation releases mic and cancels;
- no background claim;
- no duplicate engine;
- remote fallback remains;
- bundle/artifact limits pass.

### Phase 8 — Desktop native runtime with and without Python sidecar

Goal: deliver native focused and background voice on desktop.

Work:

- Integrate Rust runtime into Tauri.
- Add native Tauri commands/events and capability scopes.
- Implement desktop audio, model store, playback, tray/agent lifecycle.
- Implement native HTTP/SSE turn executor.
- Implement sidecar loopback profile and no-sidecar remote profile.
- Implement Python/native owner handoff and legacy rollback.
- Cut installed desktop PTT to native.
- Stop loading web runtime/model assets in Tauri desktop.
- Add sleep/wake, device-route, permission, network, sidecar restart, and dual-instance tests.
- Add installer/SBOM/artifact checks.

Exit gate:

- focused and tray/background turns work with UI closed;
- local-sidecar and remote-no-sidecar paths pass;
- legacy Python mode is mutually exclusive and reversible;
- WebView mic/model counts remain zero;
- desktop release builds pass on Windows/macOS/Linux.

### Phase 9 — Android native PTT and ordinary background session

Goal: deliver real native Android voice ownership.

Work:

- Convert AuroraVoiceForegroundService from skeleton to service/controller.
- Add audio capture and JNI Rust runtime.
- Add model/credential/transport storage.
- Cut Android PTT to native.
- Implement explicit background-session start/stop and notification.
- Handle lifecycle matrix from section 14.
- Add emulator tests to the existing serialized emulator runner.
- Add ARM64 physical-device endurance.
- Ensure WebView never requests mic or loads models after cutover.

Exit gate:

- emulator compile/install/service/process tests green;
- physical ARM64 PTT and locked-screen session green;
- 8-hour battery/thermal/FAR/FRR gate green;
- calls/Bluetooth/permission/Doze tests green;
- notification and Stop always work;
- Play artifact/policy review green.

### Phase 10 — Android default-assistant mode

Goal: add optional system-assistant hotword ownership without bloating the always-running service.

Work:

- Complete VoiceInteractionService/session integration.
- Request/check role only through explicit user action.
- Keep KWS component lightweight.
- Hand wake to full session/runtime process.
- Test role held/not held/denied/revoked/OEM unavailable.
- Preserve ordinary FGS/PTT fallback.

Exit gate:

- system role is optional and truthful;
- always-running service stays within resource budget;
- full turns work with UI absent;
- revocation stops capture;
- fallback remains.

### Phase 11 — iOS foreground and conditional background session

Goal: deliver native iOS PTT first, then background only if approved.

Work:

- Implement Swift audio/session + Rust FFI.
- Cut iOS PTT to native.
- Add native model/transport/playback.
- Pass simulator integration and physical PTT.
- Add user-started background audio session.
- Add interruption/route/lock/low-power/termination handling.
- Update Info.ios.plist only when the policy gate is accepted.
- Add App Review copy/privacy artifacts.
- Maintain App Intents/Shortcuts fallback.

Exit gate:

- foreground native PTT green independently;
- physical background endurance green;
- explicit indicator/stop/consent green;
- App Review/distribution approval green before capability flag;
- otherwise background remains disabled and plan records the blocked result.

### Phase 12 — Unified settings, route UX, voice profiles, and native provider follow-ups

Goal: finish user control and optional peer capabilities.

Work:

- Add product-safe runtime/background/model settings.
- Use getAuroraSurfaceProfile flags everywhere.
- Add model download/progress/recovery/removal UI.
- Add standard/cloned voice management against selected runtime.
- Add language/voice pack availability.
- Add native provider hosting only if its transport/security phase passes.
- Add support export containing redacted runtime/resource facts, never audio/internal copy in normal UI.
- Remove obsolete installed-WebView capture/model code.
- Remove old dependencies only after no-use and lockfile evidence.

Exit gate:

- no forbidden copy;
- all routes/settings persist and recover;
- management permissions remain distinct;
- no obsolete runtime starts;
- voice data migration/rollback is safe.

### Phase 13 — Release hardening and staged rollout

Goal: prove production behavior and preserve rollback.

Work:

- Full desktop/browser/emulator/simulator/physical-device matrix.
- Long-running background endurance and false-trigger beta.
- Package, SBOM, license, signature, model, and Python-leak scanners.
- Security review of JNI/FFI/Tauri commands/native transport/model parser.
- Crash/restart/update/downgrade/rollback tests.
- Accessibility and production-copy tests.
- Feature flags and per-platform rollout.
- Telemetry limited to consented resource/error metrics.
- Documentation and feature matrix update only after features ship.

Exit gate:

- every advertised surface meets its own acceptance criteria;
- no critical/high security issue;
- no unknown model/license asset;
- no duplicate owner;
- rollback is verified;
- capability matrix matches shipped behavior.

---

## 18. Durable goal graph

| Goal | Outcome | Depends on | Done when |
| --- | --- | --- | --- |
| G1 Portability truth | Engine/model/toolchain decisions are evidence-backed | Preserved baseline | Phase 4 exit |
| G2 Shared core | One state/ownership/model/transport core exists | G1 | Phase 5 exit |
| G3 Portable speech | Shippable VAD/KWS/STT/TTS packs selected | G1, G2 | Phase 6 exit |
| G4 Pure web | Foreground Rust/WASM voice replaces old web state machine | G2, G3 | Phase 7 exit |
| G5 Desktop native | Sidecar and no-sidecar desktop background turns work | G2, G3 | Phase 8 exit |
| G6 Android native | PTT and opt-in background work natively | G2, G3 | Phase 9 exit |
| G7 Mobile system modes | Android assistant and conditional iOS background pass policy | G6; iOS foreground | Phases 10–11 exit |
| G8 Unified release | UX, profiles, packaging, security, rollback, docs complete | G4–G7 | Phases 12–13 exit |

Critical path:

G1 -> G2 -> G3 -> G5/G6/iOS foreground/G4 -> platform endurance/policy -> G8.

Pure web, desktop, Android, and iOS surface integrations may proceed in parallel only after the shared core and selected engine ABI are stable.

---

## 19. Functional and lifecycle test matrix

### 19.1 Core

- PTT turn.
- Wake turn.
- cancel in every state.
- capture interruption in every capture state.
- late prior-generation frame/event.
- route change/discontinuity.
- model unload under memory pressure.
- UI detach/reconnect.
- transport disconnect/reconnect.
- runtime crash/restart.
- owner handoff.
- KWS suspended during TTS.
- bounded pre-roll erasure.

### 19.2 Model/runtime parity

- every selected pack on native and WASM;
- fixed and auto language;
- clean/noisy/far-field/accent;
- tokenizer Unicode/byte fallback;
- KWS phrase thresholds;
- VAD min/max/flush;
- STT partial/final/cancel;
- TTS standard/clone/cancel;
- corrupted/missing/wrong-variant pack;
- mismatched voice/model compatibility group.

### 19.3 Desktop

- sidecar available/unavailable/restarting;
- no-sidecar home connected/disconnected;
- native/python mode switch;
- close to tray;
- quit;
- sleep/resume;
- mic hotplug;
- two instances;
- autostart;
- update/rollback.

### 19.4 Android

- permission grant/deny/revoke;
- FGS start while visible;
- prohibited background start fails safely;
- notification stop;
- app background/force-stop/task removal;
- process death;
- lock/unlock;
- Doze/battery saver;
- call/alarm/audio focus;
- Bluetooth/wired;
- role held/denied/revoked;
- OEM unavailable;
- model download interrupted;
- emulator and physical ARM64.

### 19.5 iOS

- permission grant/deny/revoke;
- AVAudioSession interruption/resume;
- route connect/disconnect;
- screen lock;
- background/foreground;
- low-power/memory pressure;
- media services reset;
- app termination;
- model download interruption;
- simulator and physical device;
- background disabled when policy gate absent.

### 19.6 Pure web

- permission/user gesture;
- Chrome/Firefox/Safari;
- desktop/mobile;
- AudioContext suspension;
- visibility hidden;
- pagehide/freeze preparation;
- track ended/device removed;
- OPFS/IndexedDB/private mode/eviction;
- cross-origin-isolated/threaded and fallback builds;
- no background capability after lifecycle loss.

### 19.7 Security/privacy

- Tauri command scope denial;
- malformed JNI/FFI inputs;
- model path traversal/symlink/archive bomb;
- invalid signature/hash/license/revocation;
- credential redaction;
- raw audio absent from logs/events/support export;
- use/manage permission separation;
- explicit target/no fallback;
- cloned voice deletion/export/import boundaries.

---

## 20. Performance and quality gates

### 20.1 Reference devices

- 4-core CPU-only Linux/Windows desktop.
- Apple Silicon Mac.
- Mid-range and lower-memory Android ARM64 physical devices.
- Current supported iPhone and one older supported iPhone.
- Chrome/Firefox/Safari desktop.
- Chrome Android and Mobile Safari.
- Emulator/simulator for integration only.

Record hardware, OS, browser/WebView, power mode, thermal state, engine/model/build revision, model hashes, cold/warm state, and background/foreground state.

### 20.2 STT

- WER/CER by language/noise/accent bucket.
- New default beats the approved baseline by at least 25% p50/p95 end-of-utterance latency while regressing no required bucket by more than 2 absolute WER/CER points.
- Warm p95 finalization after five-second utterance:
  - desktop native/web <= 2.0 s;
  - mid-range mobile <= 3.5 s.
- No OOM, UI stall, or 10-turn thermal collapse.
- Accurate/remote routing remains available if local cannot meet language/quality.

### 20.3 TTS

- Warm p95 first audible audio for 100 characters:
  - desktop native/web <= 1.0 s;
  - mid-range mobile <= 2.5 s.
- Sustained RTF:
  - desktop <= 1.0;
  - mid-range mobile <= 1.25.
- Ordered chunks, bounded queue, no gaps/duplicates, no post-cancel audio.
- Per-language intelligibility/pronunciation/speaker similarity/clipping/EOS gates.
- Model switch never exceeds device memory ceiling through overlapping residency.

### 20.4 VAD/KWS

- VAD p95 processing remains below frame interval.
- End-of-speech overhead <= configured silence window + 150 ms.
- Wakeword <= 1 false accept per 8 hours of Aurora household-noise corpus.
- Wakeword <= 10% false reject per supported phrase/language/accent/distance bucket.
- Foreground eligibility loss stops browser capture <= 250 ms where lifecycle callbacks occur.
- Android/iOS Stop action stops native capture <= 500 ms.

### 20.5 Background resource budget

Phase 4 records a baseline and may tighten these provisional ceilings, but may not silently weaken them:

- resident KWS+VAD memory <= 100 MiB on mid-range mobile;
- average additional CPU while idle-listening <= 5% on mid-range device;
- no thermal warning/throttling in 30-minute controlled run;
- additional 8-hour locked-screen battery drain <= 8 percentage points on the Android reference device;
- iOS budget set before implementation from the selected physical-device baseline and approved product session behavior;
- full STT/TTS loads are transient unless warm residency stays within declared budget.

### 20.6 Web

- No fixed 768 MiB SharedArrayBuffer.
- Main-thread long tasks attributable to voice <= 50 ms p95 during capture.
- WASM thread build requires cross-origin isolation; fallback remains truthful.
- Model download and peak memory remain within declared device-class budgets.

Failure disposition:

- route to eligible peer;
- use a smaller pack;
- make a capability foreground-only;
- keep feature opt-in;
- or withhold the platform/language.

Never relax privacy, ownership, license, or lifecycle rules to meet performance.

---

## 21. Acceptance criteria

### Shared runtime

- One core state machine runs in native and WASM builds.
- No duplicate capture/model owner exists.
- Handoff is generation-safe.
- UI detach does not break native turns.
- Core has no Tauri/Kotlin/Swift/browser dependency.

### Models

- Every advertised pack has immutable provenance, license approval, hashes, target variants, parity evidence, and resource results.
- VAD/KWS/STT/TTS capability is per language and target.
- PocketTTS is not advertised locally unless a distributable pack passes.
- Voice states never cross incompatible engine/model groups.

### Pure web

- PTT/local speech works while eligible.
- Hidden/suspended/frozen/discard preparation stops or invalidates capture.
- No background wakeword claim.
- Worker/WASM does not block rendering.

### Desktop

- Native PTT/background turns work with sidecar and no-sidecar profiles.
- Python mode remains reversible and mutually exclusive.
- Tray/background does not require WebView.
- Sleep/resume/device changes recover safely.

### Android

- FGS session starts only through allowed flow.
- Notification/indicator/Stop are always present.
- Background wake/turn works on physical ARM64.
- Optional assistant role works only when selected.
- Battery/thermal/lifecycle gates pass.

### iOS

- Native PTT works independently.
- Background capability remains false until user-started session, physical-device, privacy, and review gates pass.
- No prohibited keep-alive behavior.
- Termination is reported honestly.

### Transport/contracts

- Native uses generated authoritative DTOs/methods.
- Existing authorization/redaction/route binding remains.
- Background turns need no WebView.
- HTTP/SSE first path has cancellation/reconnect/idempotency tests.

### Privacy/release

- No raw audio/log leakage.
- No forbidden model/voice/Python asset in client artifacts.
- Product copy is end-user safe.
- Rollback preserves user data and remote/Python routes.

---

## 22. Rollout and rollback

### 22.1 Rollout order

1. Internal engine/model parity builds.
2. Pure-web foreground PTT behind a developer flag.
3. Desktop native PTT.
4. Desktop native background opt-in.
5. Android native PTT.
6. Android ordinary background beta.
7. Android assistant-role beta.
8. iOS native PTT.
9. iOS background TestFlight only after policy approval.
10. Per-platform staged production enablement.

### 22.2 Runtime feature flags

Internal flags are independently reversible for:

- Rust/WASM web runtime;
- native desktop PTT;
- native desktop background;
- Android PTT;
- Android FGS background;
- Android assistant role;
- iOS PTT;
- iOS background;
- each KWS/STT/TTS pack/language;
- native provider hosting.

### 22.3 Rollback

- Stop the affected native runtime and release capture.
- Re-enable prior PTT path only on surfaces where it remains safe.
- Desktop with sidecar may select Python voice.
- Pure web may use remote STT/TTS if local WASM is disabled.
- Android/iOS retain native PTT fallback when background is disabled.
- Keep model/voice data unless corrupt/revoked or the user removes it.
- Never silently delete cloned voice profiles.
- Withdraw provider/capability readiness before disabling runtime.

---

## 23. Execution topology and integration discipline

### 23.1 Handoff start

The next main session must:

1. confirm the old implementation session has stopped;
2. confirm the integration worktree is clean;
3. record its current HEAD rather than assuming 5a8a33dc is still final;
4. treat old Phase 4–9 tasks as cancelled/superseded;
5. start with Phase 4 only;
6. avoid touching the user's primary dirty worktree.

### 23.2 Ownership lanes after Phase 4

- Integration owner: Rust workspace root, Cargo.lock, root package/lockfiles, Tauri Cargo/config, generated inventories, platform-surface, CI.
- Core lane: aurora-voice-core/testkit.
- Engine/model lane: sherpa adapter, build scripts, parity harness, manifests.
- Web lane: aurora-voice-wasm/package/AudioWorklet/browser tests.
- Desktop lane: Tauri native runtime and desktop tests.
- Android lane: Kotlin service/audio/JNI/emulator/physical evidence.
- iOS lane: Swift audio/FFI/simulator/physical/policy evidence.
- Contract lane: Rust generator and cross-language fixtures.
- Security/verifier lane: redaction, permissions, artifacts, final evidence.

### 23.3 Rules

- Isolated branches/worktrees for concurrent writers.
- One named owner for shared manifests, locks, generated files, and CI.
- Every lane commits coherent verified slices with the Lore protocol.
- Stage only owned paths; inspect staged diff.
- No worker pushes.
- Integration owner cherry-picks/rebases and resolves conflicts.
- Dependent phases remain sequential; independent surface lanes may parallelize only after shared APIs freeze.

---

## 24. File-level implementation index

Existing files expected to change:

- packages/aurora-ui/src/platform-surface.ts
- packages/aurora-ui/src/assistant-view.tsx
- packages/aurora-ui tests for PTT/copy/capability
- packages/aurora-sdk generated contract sources and conformance tools
- apps/aurora-tauri/src-tauri/Cargo.toml
- apps/aurora-tauri/src-tauri/src/lib.rs, with voice code extracted rather than expanded inline
- apps/aurora-tauri/src-tauri/android/aurora-native-plugin/src/main/AndroidManifest.xml
- AuroraVoiceForegroundService.kt
- AuroraVoiceInteractionService.kt
- AuroraVoiceInteractionSessionService.kt
- AuroraNativePlugin.kt
- apps/aurora-tauri/src-tauri/Info.ios.plist
- AuroraNativePlugin.swift
- apps/aurora-tauri Android/iOS READMEs and preflight policy files
- scripts/generate_backend_inventory.py and SDK conformance scripts
- docs/ARCHITECTURE.md
- docs/FEATURE_MATRIX.md
- docs/FRONTEND_AND_UI_ARCHITECTURE.md
- docs/API_AND_CONTRACTS.md
- docs/AUTH_AND_PERMISSIONS.md
- docs/DEPENDENCIES.md

New areas:

- rust/**
- packages/aurora-voice-web/**
- tools/voice-runtime/**
- tests/fixtures/local_speech/runtime/**
- platform-specific voice runtime tests/evidence scripts.

Python speech files should change only for targeted compatibility, capture-owner handoff, or generated contract additions. The native program is not permission to refactor the completed provider work.

---

## 25. Hard stop and escalation conditions

Stop the affected lane and record evidence if:

- PocketTTS assets lack commercial/redistribution rights.
- Exact multilingual PocketTTS conversion cannot be reproduced.
- A selected model requires unsupported native or WASM operators.
- Native and WASM tokenizer/pre/post behavior fails parity.
- cancellation allows stale audible TTS.
- Rust/NDK/Xcode/Emscripten dependency graph cannot be reproduced.
- toolchain upgrade breaks supported Tauri desktop/mobile builds.
- Android service accesses the microphone outside an allowed/visible flow.
- iOS background mode cannot be justified or approved.
- pure web continues to claim listening after lifecycle loss.
- WebView and native runtime both open capture/load a selected model.
- background request generation depends on JavaScript.
- native transport bypasses typed contracts, authorization, route binding, or redaction.
- physical-device evidence is absent for battery/thermal/acoustic/background claims.
- model weights, private voices, training assets, credentials, or Python appear in forbidden client artifacts.
- rollback deletes or corrupts user voice data.

Allowed recovery:

- task-specific engine adapter behind the same Rust core;
- smaller or language-specific pack;
- remote provider;
- foreground-only capability;
- platform/language withheld.

Disallowed recovery:

- hidden keep-alive tricks;
- unlicensed pack;
- second WebView runtime;
- weakened consent/notification;
- untyped route;
- fabricated benchmark evidence.

---

## 26. Verification commands and evidence shape

Commands are added to repository scripts during implementation; direct forms below are the expected core.

Rust:

    cargo fmt --manifest-path rust/Cargo.toml --all --check
    cargo clippy --manifest-path rust/Cargo.toml --workspace --all-targets -- -D warnings
    cargo test --manifest-path rust/Cargo.toml --workspace

Target builds:

    cargo build --manifest-path rust/Cargo.toml --target x86_64-unknown-linux-gnu
    cargo build --manifest-path rust/Cargo.toml --target x86_64-pc-windows-msvc
    cargo build --manifest-path rust/Cargo.toml --target aarch64-apple-darwin
    cargo build --manifest-path rust/Cargo.toml --target aarch64-linux-android
    cargo build --manifest-path rust/Cargo.toml --target aarch64-apple-ios

Web:

    pnpm --filter @aurora/voice-web build
    pnpm --filter @aurora/voice-web test
    pnpm --filter @aurora/ui test
    pnpm --filter @aurora/web build

Tauri:

    pnpm --filter @aurora/tauri-ui typecheck
    pnpm --filter @aurora/tauri-ui test
    pnpm --filter @aurora/tauri-ui android:preflight:strict
    pnpm --filter @aurora/tauri-ui android:build:client:apk:x86_64
    pnpm --filter @aurora/tauri-ui android:smoke
    pnpm --filter @aurora/tauri-ui ios:policy
    pnpm --filter @aurora/tauri-ui ios:build:client:simulator
    pnpm --filter @aurora/tauri-ui ios:smoke:simulator

Contracts/Python:

    make check-sdk-backend-contracts
    make check-docs
    make lint
    make unit

Release evidence records:

- commit and exact source revisions;
- command and exit code;
- target/device/OS/browser;
- model/engine/build hashes;
- cold/warm/background state;
- first failure;
- redacted logs;
- resource/quality metrics;
- untested/manual gaps;
- artifact/SBOM/license report;
- rollback result.

Warm iterative checks are acceptable during development. Final release evidence must be from clean builds with caches declared and no ignored candidate report treated as canonical release evidence.

---

## 27. Primary references

Repository evidence:

- [Aurora platform surface](../../packages/aurora-ui/src/platform-surface.ts)
- [Aurora focused PTT implementation](../../packages/aurora-ui/src/assistant-view.tsx)
- [Tauri Rust crate](../../apps/aurora-tauri/src-tauri/Cargo.toml)
- [Android native boundary](../../apps/aurora-tauri/src-tauri/android/README.md)
- [iOS native boundary](../../apps/aurora-tauri/src-tauri/ios/AuroraNativePlugin/README.md)
- `tools/pockettts-raven/W0_EVIDENCE.md` at preserved integration head `5a8a33dc5392c3b50b1b4860c5f90230f96e9cdc`
- `benchmarks/local-speech/stt/candidates.json` at preserved integration head `5a8a33dc5392c3b50b1b4860c5f90230f96e9cdc`
- `benchmarks/local-speech/kws/README.md` at preserved integration head `5a8a33dc5392c3b50b1b4860c5f90230f96e9cdc`

Rust/Tauri/audio:

- [Rust Android targets](https://doc.rust-lang.org/rustc/platform-support/android.html)
- [Rust iOS targets](https://doc.rust-lang.org/stable/rustc/platform-support/apple-ios.html)
- [Tauri mobile plug-ins and Rust JNI/FFI](https://v2.tauri.app/develop/plugins/develop-mobile/)
- [CPAL platforms, MSRV, and WASM requirements](https://github.com/RustAudio/cpal)

Speech engines/models:

- [sherpa-onnx repository and platform/API matrix](https://github.com/k2-fsa/sherpa-onnx)
- [sherpa-onnx Rust API](https://k2-fsa.github.io/sherpa/onnx/rust-api/index.html)
- [sherpa-onnx PocketTTS](https://k2-fsa.github.io/sherpa/onnx/tts/pocket.html)
- [sherpa-onnx TTS WebAssembly](https://k2-fsa.github.io/sherpa/onnx/tts/wasm/index.html)
- [sherpa-onnx Silero VAD](https://k2-fsa.github.io/sherpa/onnx/vad/silero-vad.html)
- [sherpa-onnx keyword spotting](https://k2-fsa.github.io/sherpa/onnx/kws/index.html)
- [sherpa-onnx Moonshine](https://k2-fsa.github.io/sherpa/onnx/moonshine/models.html)
- [Current sherpa PocketTTS model card and license warning](https://huggingface.co/csukuangfj2/sherpa-onnx-pocket-tts-int8-2026-01-26)
- [Official Kyutai PocketTTS](https://github.com/kyutai-labs/pocket-tts)
- [ONNX Runtime APIs and community Rust status](https://onnxruntime.ai/docs/api/)
- [ONNX Runtime Web support matrix](https://onnxruntime.ai/docs/get-started/with-javascript/web.html)

Browser lifecycle:

- [Chrome Page Lifecycle API](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)
- [Web Audio suspended-context behavior](https://www.w3.org/TR/webaudio-1.0/)

Android:

- [Foreground-service background start and microphone restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)
- [VoiceInteractionService lifecycle](https://developer.android.com/reference/android/service/voice/VoiceInteractionService)

iOS:

- [AVAudioSession recording/background behavior](https://developer.apple.com/documentation/avfaudio/avaudiosession/category-swift.struct/record)
- [Handling audio interruptions](https://developer.apple.com/documentation/AVFAudio/handling-audio-interruptions)
- [Responding to route changes](https://developer.apple.com/documentation/avfaudio/responding-to-audio-route-changes)
- [App Review recording consent/indication requirements](https://developer.apple.com/app-store/review/guidelines/)

---

## 28. Main-session handoff

The main session should receive these instructions with this plan:

1. Stop/cancel execution of the former Phase 4–9 TypeScript/WebView plan.
2. Preserve the current integrated Phase 0–3 work and record the actual final integration HEAD.
3. Do not create @aurora/local-speech as a TypeScript-owned runtime.
4. Do not integrate Raven, Transformers.js, or browser VAD as production defaults.
5. Start at revised Phase 4: engine/toolchain/audio/transport portability proof.
6. Treat sherpa-onnx as the primary candidate, not a foregone conclusion.
7. Treat the current sherpa PocketTTS pack as blocked from release until licensing and multilingual pack gates pass.
8. Build one Rust orchestration core for native and WASM.
9. Make installed WebViews controllers only after native cutover.
10. Keep existing PTT temporarily, then migrate it into the shared runtime.
11. Implement the full native background turn and native transport; KWS alone is not completion.
12. Keep pure web foreground-only.
13. Require physical Android/iOS evidence for background release.
14. Do not claim completion until Phase 13 acceptance and rollback gates are green.

The first implementation deliverable is the Phase 4 ADR/evidence bundle. It must answer, with real builds and model artifacts:

- exact engine/API/build choice;
- exact Rust MSRV/toolchain choice;
- exact desktop/Android/iOS/web audio adapter choices;
- exact web linking shape;
- exact shippable VAD/KWS/STT/TTS pack candidates;
- exact PocketTTS license/language disposition;
- exact native background transport shape;
- exact blockers and fallbacks.

No production surface integration should begin before that deliverable passes review.
