# V496 native process-isolation source review

Verdict: **qualified admission for disposable, one-process ordinary UI/onboarding and independently verified typed/synthesis results; NOT admission for unchanged native microphone/full-audio acceptance.** The proposed flag is not keyring-only. No launch, build, device, model, test or network action performed.

## Exact flag effects

- apps/aurora-tauri/src-tauri/src/lib.rs:9634–9639 installs the app-wide alternate credential builder only for desktop + debug_assertions + feature desktop-native-voice-e2e + AURORA_DESKTOP_NATIVE_VOICE_E2E=1. desktop_native_voice_e2e_keyring.rs:10–45 uses a shared process-memory HashMap keyed by target/service/user and explicitly reports ProcessOnly. It does not reuse the host default keyring. Local envelope-key access through lib.rs:7608–7665 also uses that builder, so database key custody is deliberately changed, not merely path-isolated.
- **Material omission from README:** native_voice.rs:1945–1951 selects DeterministicE2eAudioInput instead of CpalAudioInput under the same flag. The gate is :2277–2279. The deterministic implementation (:2100–2203) emits synthetic alternating ±0.2 PCM frames with constructed timestamps and 10 ms pacing; it does not read the microphone or the frozen spoken WAV. Not invoking the JS hook does not undo this automatic native selection. Therefore the recipe cannot certify ordinary native microphone permission/device/open/capture, captured speech fidelity, wake/background physical audio or an end-to-end task whose input is represented as actual speech capture.
- rust/crates/aurora-voice-native/src/desktop_capture.rs:267 and :882–890 additionally use the environment in debug builds to request a fixed ~10 ms CPAL input buffer. Thus the environment also changes that input configuration where CPAL capture is used; the lower-level gate does not itself require the Tauri E2E feature.
- The flag does **not**, in the inspected connected runtime, automatically replace STT/LLM/TTS results: native_voice.rs:2592–2790 still constructs installed/Gateway/mesh STT and TTS providers from normal profile/model selection, uses normal transport_for_profile, and creates CpalAudioOutput (:2768). transport_for_profile_with_timeout (:3302–3348) preserves normal local/remote authentication and audio policy. Later feature-gated mock provider bodies in this file are unit-test code, not proof of runtime mocks. Source continuity is not evidence that these providers ran successfully.
- native_voice.rs:536–552 exposes the bounded tray-toggle E2E command under the debug feature/environment gate; the separate E2E capability file grants its extra test permission/window-hide. Neither is necessary to substitute ordinary UI onboarding with a test scenario. Frontend main.tsx:29–32 separately gates import with VITE_AURORA_DESKTOP_NATIVE_VOICE_E2E; desktop-native-voice-e2e.ts:155–179 installs a callable hook only with that Vite flag plus autosidecar=0. Installing the hook is distinct from invoking it. Its scenarios call persistRuntimeProfile (:529–542) and build prepared profile documents (:660 onward); invoking those is not ordinary visible onboarding and cannot be borrowed as such.

## Eligible and ineligible claims

Absolute private XDG roots plus private D-Bus and the memory keyring are a source-supported disposable one-process scope as described in README. Keep UID/HOME/identifier and runtime role resolution unchanged. This can support actual ordinary visible onboarding/navigation, same-process data operations/history selection and real typed Assistant/read-aloud results if those paths are exercised and exact outputs/IDs/audio completion independently observed. It does not itself bypass a model/readiness/auth gate or fabricate those results. The ordinary role/account choices must still be made by the normal product flow, rather than the separate profile-writing JS scenario.

OS-keyring integration/persistence, cross-process encrypted-data reopen, saved credentials/desktop-thin profile recovery after exit, host-account migration, and production storage durability are ineligible. Even if ordinary UI history can reopen within the same live process, that is not a fresh-process persistence result. Default production microphone/device buffering and all claims requiring captured real speech are also ineligible under this exact flag. No physical/acoustic playback claim follows from constructing CpalAudioOutput or a software success event. No mobile/iOS/full-feature or campaign-barrier acceptance follows.

## Minimal future admission

Root may use the exact existing artifact/flag recipe for the narrower one-process scope, explicitly retaining the synthetic-input and process-keyring qualifications. Before launch, establish the actual debug feature/artifact identity, private absolute roots/session and clean single-process ownership without touching active campaigns. During the actual run retain the effective path containment, source/artifact identity and normal visible onboarding/result evidence; afterward retire only owned resources and treat the encrypted private DB as disposable. Do not silently disable a gate or fall back to the host keyring to broaden the claim. With this unchanged combined flag, ordinary native real-input/full-audio acceptance remains **not admitted**; this review does not propose a redesign, flag ladder or additional test matrix.

Read-only source review bounded to the requested effects. No canonical source/index/goal/ledger/vault or active campaign changes; only this private report written. Root owns future resource admission, actual run and result acceptance.

## Reviewed source hashes

- .git/aurora-handoff-import-20261006/native-profile-isolation-v496/README.md: `306b53f21ef1dcd612f105a2609067a158421eb6d098c1ac106ad347351f1faf`
- apps/aurora-tauri/src-tauri/src/lib.rs: `39b18ff7f46e157b72b35c042134073c74118cee173a345e3631aacc308c97af`
- apps/aurora-tauri/src-tauri/src/desktop_native_voice_e2e_keyring.rs: `d7dc6735951de2721153ec1729a2f285b77b2c9053fd5af742ddcd3032189769`
- apps/aurora-tauri/src-tauri/src/native_voice.rs: `cb66c50d83b199c7734ea96ac84a88e864d6f6ac9c29c0504f8a5b088ee41e60`
- rust/crates/aurora-voice-native/src/desktop_capture.rs: `9f6d103d5884b37a0af92fdbabc9e619bcb1f61582549024deba6c24bffd69a7`
- apps/aurora-tauri/src/main.tsx: `0fab090c8b8703ebeeb11b66a8e6dd0beec4cb97a3e63ca23e3aaa09dec13b5b`
- apps/aurora-tauri/src/desktop-native-voice-e2e.ts: `53823bcb7eaed87d8340e88c12556dada358961865786dd7752286078f11813c`
- apps/aurora-tauri/src-tauri/Cargo.toml: `491f2111c51871ed150cda5d5905844f5a5322c591422016c2e41580d2bf6901`
- apps/aurora-tauri/src-tauri/tauri.desktop-native-voice-e2e.conf.json: `c4b7b0d28bb3079c6075f73cfa9acbc53e09a74c8c67a9838aaacb5725ccdbdd`


## Requested fixed-WAV ingress clarification

No fixed WAV/PCM fixture ingress is supported by the inspected existing native DesktopAudioInput path. native_voice.rs:1945–1951 chooses either production CPAL input or DeterministicE2eAudioInput::new(); the latter's constructor (:2053 onward) has no file/PCM input parameter, and next_frame (:2147–2203) constructs the alternating square-wave samples directly. Its frame-limit/pause helpers only bound/gate that generated stream; they do not ingest the frozen speech WAV. No runtime profile seeding is needed for that automatic selection, but declining seeding does not change its samples. Therefore this exact feature cannot be credited as the frozen spoken-WAV ingress. A separate host audio routing technique is outside this inspected path and is not admitted by this source review. No new flag or implementation proposed, and no additional source walk/execution performed.
