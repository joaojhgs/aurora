# Mobile / Native Feasibility Refinement Lane

- Team: `aurora-ui-refined-pla-2b6663ce`
- Worker: `worker-3`
- Task: `6` — docs-only mobile/native feasibility refinement
- Date: 2026-06-10
- Scope: Android assistant role and voice-service feasibility; iOS App Intents / Shortcuts / Siri integration without Siri replacement; mobile inference runtime candidates; Tauri Swift/Kotlin plugin implications; platform gating and experiment acceptance criteria.

## Executive Decision

Aurora should treat mobile as a **tiered native-capability node**, not as a desktop Python clone. The default feasibility posture is:

1. **Android:** feasible as a staged native integration, beginning with a thin Tauri/webview shell plus HTTP/mesh transport, then adding Kotlin plugins for microphone, notifications, foreground service, secure storage, and assistant-role experiments. Android default-assistant behavior is possible only after proving `ROLE_ASSISTANT` availability, user-grant flow, and `VoiceInteractionService` qualification on real devices.
2. **iOS:** feasible for system integration through App Intents, App Shortcuts, Shortcuts automation, Spotlight, widgets, notifications, share sheets, and supported SiriKit/App Intent domains. Aurora must **not** promise Siri replacement or always-listening global assistant behavior on iOS.
3. **Local inference:** feasible only as per-capability tiers. Use mobile-native inference runtimes behind an `InferenceProvider` boundary; do not attempt to ship the current desktop Python runtime/dependency stack unchanged on Android/iOS.
4. **Tauri:** official Tauri 2 remains the best mobile shell candidate because its native plugin model has first-class Kotlin/Swift surfaces. Python-backed Tauri/PyTauri remains useful for desktop/prototype reuse but must not be selected for mobile until it passes CPython/dependency and store-policy gates.

## Local Evidence Baseline

| Evidence | What it proves | Implication |
| --- | --- | --- |
| `.omx/context/ui-refinement-team-20260610T2033Z.md:5-17` | Required outputs include mobile UI/UX, feature/service availability graph, and hard constraints: no source implementation, preserve bus-first/typed contracts, and avoid iOS Siri replacement claims. | This report is a planning artifact only and must encode mobile caveats explicitly. |
| `.omx/plans/ui-all-in-one-distributed-assistant-roadmap.md:170-178` | Mobile is already framed as tiered capability levels M0-M3. | Keep mobile planning tiered: thin shell first, native plugins second, local inference third, full node only if proven. |
| `.omx/plans/ui-all-in-one-distributed-assistant-roadmap.md:204-218` | Platform matrix marks Android/iOS thin shells and local nodes as spikes/work, with iOS full local node constrained. | Treat both Android and iOS as experiment-gated, not pre-approved parity with desktop. |
| `.omx/plans/ui-all-in-one-distributed-assistant-roadmap.md:246-257` | Runtime decision gates require Android/iOS builds, native capability gates, Python runtime gate, and app-store gate. | Mobile feasibility is decided by release-mode device experiments, not by desktop success. |
| `docs/UI_INTEGRATION.md:5` | Current UI is PyQt6 in main thread with services in background threads. | Current UI is a behavior reference, not a mobile architecture. |
| `docs/UI_INTEGRATION.md:42-52` | `UIBridge` already adapts UI ↔ bus bidirectionally. | Preserve adapter semantics in `NativeMobileTransport` / Tauri plugins. |
| `docs/UI_INTEGRATION.md:115-133` | UI depends on live STT, orchestrator, TTS, and DB events. | Mobile must prove event streaming/plugin event emitters; request/response is insufficient. |
| `app/shared/contracts/models/gateway.py:52-65` | `MethodInfo` includes bus topic, exposure, permissions, method type, and schemas. | Mobile UI should render capability availability from registry metadata. |
| `app/services/gateway/fastapi_app.py:199-299` | Gateway exposes registry, services, service health, and generated routes. | Thin mobile/server mode can start with HTTP gateway + event stream. |
| `pyproject.toml:38`, `pyproject.toml:63-88`, `pyproject.toml:119-127` | Aurora targets Python `>=3.10,<3.12` and has heavy runtime audio/ML dependencies. | Do not assume Android/iOS can embed or execute the desktop Python runtime. |
| Team message `77614994-ad0d-45ab-a222-ba2220e76c8f` in `.omx/state/team/aurora-ui-refined-pla-2b6663ce/mailbox/leader-fixed.json` | Worker-3 supplemental G001 advisory recommended official Tauri 2/Rust shell with supervised Python sidecar/loopback, keeping Python-backed Tauri experimental. | This lane extends that recommendation specifically for mobile/native feasibility. |

## External Evidence Baseline

| Topic | Evidence URL | Feasibility implication |
| --- | --- | --- |
| Android roles | https://developer.android.com/reference/android/app/role/RoleManager | `RoleManager` exposes `ROLE_ASSISTANT`, but apps must query role availability and require user consent. Do not assume every device/OEM exposes or grants it. |
| Android assistant role requirements | https://source.android.com/docs/core/permissions/android-roles | A qualifying assistant must provide an assist activity and/or an always-on voice interaction service with `BIND_VOICE_INTERACTION` and supported assist capability. |
| Android `VoiceInteractionService` | https://developer.android.com/reference/android/service/voice/VoiceInteractionService | The service must declare `android.service.voice.VoiceInteractionService`, require `BIND_VOICE_INTERACTION`, and keep heavy work outside the always-running service. |
| Apple App Intents | https://developer.apple.com/documentation/appintents | App Intents make app actions/content available to Siri, Spotlight, Shortcuts, widgets, and Apple Intelligence surfaces. |
| Apple App Shortcuts | https://developer.apple.com/documentation/appintents/app-shortcuts | App Shortcuts bind App Intents to user-facing phrases/metadata for Siri/Shortcuts/Spotlight execution. |
| Apple Siri integration guidance | https://developer.apple.com/videos/play/wwdc2024/10133/ | Apple positions SiriKit and App Intents as the integration frameworks for exposing app functionality to Siri and Apple Intelligence, not as third-party Siri replacement APIs. |
| SiriKit current posture | https://developer.apple.com/documentation/sirikit/ | SiriKit/Intents frameworks provide legacy support for Siri interactions, Shortcuts actions, and widget configuration. |
| Tauri mobile plugins | https://v2.tauri.app/develop/plugins/develop-mobile/ | Tauri plugins can run Kotlin/Java on Android and Swift on iOS, exposing native commands to Rust/JavaScript. |
| Tauri 2 mobile / plugins | https://v2.tauri.app/blog/tauri-20/ | Tauri 2 extends the single UI codebase to iOS/Android and supports Swift/Kotlin mobile plugin integration. |
| Tauri sidecars | https://v2.tauri.app/develop/sidecar/ | Desktop can bundle Python/API-server sidecars; this supports desktop local-node packaging, not a proof of mobile Python viability. |
| Python-backed Tauri caveat | https://github.com/marcomq/tauri-plugin-python | The plugin README notes Android resource limitations and mobile PyO3/CPython cross-compile uncertainty; it is not yet a safe mobile default for Aurora. |
| ExecuTorch | https://docs.pytorch.org/executorch/stable/index.html | Candidate for PyTorch-derived edge/mobile inference, including Android/iOS and LLM workflows. |
| ONNX Runtime Mobile | https://onnxruntime.ai/docs/tutorials/mobile/ | Candidate for ONNX-format mobile inference on Android/iOS, especially smaller STT/TTS/embedding/classifier workloads. |
| MLC LLM | https://llm.mlc.ai/docs/ | Candidate for native LLM deployment across platforms, including mobile-focused packages/examples. |
| Apple Core ML | https://developer.apple.com/documentation/coreml | iOS-native inference candidate optimized for CPU/GPU/Neural Engine and memory/power constraints. |

## Android Assistant Feasibility

### Target tiers

| Tier | Android capability | Feasibility | Required proof |
| --- | --- | --- | --- |
| A0 | Thin Aurora client: webview/Tauri shell using HTTP gateway and remote/peer capabilities. | High. | Login/pairing, registry discovery, command invoke, event stream, notification display. |
| A1 | Native shell features: microphone capture, push/local notifications, secure token storage, share intents, background/foreground service for active sessions. | Medium-high. | Kotlin plugin POC with permission prompts, foreground service notification, token storage, and event emission into webview. |
| A2 | Assistant-role integration: request `ROLE_ASSISTANT`, handle assist context, launch Aurora session from system assist gesture. | Medium/uncertain. | `RoleManager.isRoleAvailable(ROLE_ASSISTANT)`, app qualifies, user can grant role, assist invocation reaches Aurora on Pixel and one non-Pixel OEM. |
| A3 | `VoiceInteractionService` / hotword-style integration. | Medium-low until proven. | Service manifest and `BIND_VOICE_INTERACTION` qualification; lightweight always-running service; separate session process; recognition service strategy; battery/background review. |
| A4 | Local model node. | Medium for small models; low for full Aurora desktop parity. | One STT/TTS/embedding or small LLM provider runs locally with thermal/battery budget and plugin event reporting. |

### Android design constraints

- Always use `RoleManager.isRoleAvailable(RoleManager.ROLE_ASSISTANT)` and `isRoleHeld(...)` before showing assistant-role UX. Android explicitly warns role availability may change with system app updates.
- Gate assistant-role onboarding behind a transparent explanation: Aurora can request to become a digital assistant where supported, but the user/OEM/role controller controls approval.
- Treat `VoiceInteractionService` as a **thin coordinator** only. Android documentation says heavy operations and UI should live in associated session services/processes, not in the always-running service.
- Require foreground-service and microphone permission UX when capturing audio outside an active visible screen.
- Do not promise always-listening wake word until a battery/privacy/Play-policy review passes.

### Android experiment acceptance criteria

1. **Role availability gate:** On at least Pixel + Samsung/other OEM, app records whether `ROLE_ASSISTANT` is available, requestable, held, denied, or unsupported.
2. **Assist invocation gate:** After user grants role, invoking the Android assistant affordance opens an Aurora session with explicit route/capability metadata.
3. **Voice service gate:** Minimal `VoiceInteractionService` registers correctly, remains lightweight, and delegates session work to a separate component/process.
4. **Permission gate:** Microphone, notification, foreground service, and secure storage prompts are explicit, recoverable, and reflected in the capability graph.
5. **Event gate:** Native Kotlin plugin emits listening/processing/speaking/error events into the same UI event abstraction used by HTTP/mesh transports.
6. **Policy gate:** Document Play Store posture for background audio, hotword detection, foreground services, embedded model downloads, and user data handling.

## iOS Integration Feasibility

### Target tiers

| Tier | iOS capability | Feasibility | Required proof |
| --- | --- | --- | --- |
| I0 | Thin Aurora client: webview/Tauri shell using HTTP gateway and remote/peer capabilities. | High. | Login/pairing, registry discovery, command invoke, event stream, keychain storage. |
| I1 | Native shell features: microphone, notifications, secure storage, share sheet, widgets, shortcuts, Spotlight deep links. | Medium-high. | Swift plugin POC with permissions, keychain, notifications, App Group/file constraints, webview event bridge. |
| I2 | App Intents / App Shortcuts for Aurora actions. | High for explicit app actions. | `SendPrompt`, `StartVoiceSession`, `SummarizeClipboard`, `OpenConversation`, `RunAutomation` intents appear in Shortcuts/Spotlight and call Aurora transport safely. |
| I3 | Siri integration through supported App Intent/SiriKit domains. | Medium. | App Intents work in Shortcuts immediately; Siri works only for supported schemas/domains and OS availability. |
| I4 | Full Siri replacement / global always-listening assistant. | Not a valid product claim. | Non-goal; use supported Apple surfaces only. |
| I5 | Local model node. | Medium for small Core ML/ONNX/MLC/ExecuTorch workloads; low for full desktop parity. | One local provider completes latency/power/memory gates and degrades gracefully to server/peer route. |

### iOS design constraints

- Do not claim Siri replacement. The correct phrasing is: **Aurora exposes actions to Siri, Shortcuts, Spotlight, widgets, Action Button/Controls where supported by Apple frameworks.**
- Prefer App Intents for Aurora-specific actions and App Shortcuts for discoverable voice phrases; use SiriKit only where Aurora maps to an existing SiriKit domain.
- Design every iOS intent as an authenticated, auditable Aurora command envelope. The intent should not bypass the AuroraClient permission model.
- App Intents should route through the same capability registry as UI components; unavailable or unauthorized actions must produce clear, privacy-safe failure states.
- Local model downloads and background execution require separate App Store/privacy review; keep initial iOS shell thin.

### iOS experiment acceptance criteria

1. **App Intents gate:** Implement no-code-design spec for initial intents: `StartVoiceSession`, `SendPrompt`, `OpenConversation`, `SummarizeSelectedText`, `RunNamedAutomation`, `ShowServiceStatus`.
2. **Shortcuts gate:** Each intent appears in Shortcuts with user-understandable title, parameters, result, and failure state.
3. **Siri gate:** For supported OS/framework domains, a TestFlight build can invoke at least one Aurora App Shortcut through Siri without implying Siri replacement.
4. **Spotlight/deep-link gate:** Aurora conversations/actions are discoverable through Spotlight only when local privacy settings allow indexing.
5. **Auth gate:** Intent execution uses current principal/token, handles expired auth, and logs audit metadata for mutating/admin actions.
6. **Native plugin gate:** Swift plugin can request microphone, send notification, use secure storage, and emit events to the webview without blocking the UI.

## Mobile Inference Runtime Candidates

| Candidate | Best fit | Strengths | Risks / gates |
| --- | --- | --- | --- |
| ExecuTorch | PyTorch-origin STT/TTS/embedding/small LLM models on Android/iOS. | Official PyTorch edge/mobile direction; supports Android/iOS and LLM workflows. | Requires export/quantization pipeline, operator coverage check, native packaging, model size/power tests. |
| ONNX Runtime Mobile | ONNX-format classifiers, embeddings, smaller STT/TTS components, cross-platform inference. | Mature mobile story with Android/iOS tutorials; aligns with current Aurora `onnxruntime` dependency conceptually. | Mobile package uses reduced operators/format decisions; model conversion and acceleration-provider differences need proof. |
| MLC LLM | Local LLM chat/inference on mobile GPUs/accelerators. | Purpose-built high-performance LLM deployment engine with mobile examples. | Model compatibility, quantization quality, app size, memory, thermals, licensing, and update delivery. |
| Core ML | iOS-native models using Apple CPU/GPU/Neural Engine. | Best Apple-platform integration and power/performance posture. | iOS-only; conversion and model update pipeline needed; not a shared Android strategy. |
| Remote/peer provider via Aurora mesh/server | Fallback for models too large for device. | Preserves UX on constrained devices and reuses Aurora bus/mesh architecture. | Requires clear privacy/cost/latency route UI and offline degradation. |

### Required provider boundary

Mobile inference must sit behind a provider interface, not inside UI components:

```text
AuroraClient.invoke / subscribe
  -> Capability graph route preview
  -> NativeMobileTransport / HttpGatewayTransport / MeshTransport
  -> InferenceProvider: remote | peer | local-executorch | local-onnx | local-mlc | local-coreml
```

Each provider advertises:

- `provider_id`, `runtime`, `platform`, `model_id`, `model_size`, `quantization`, `task_types`.
- `privacy_class`, `offline_capable`, `power_estimate`, `thermal_state`, `requires_download`.
- `input_schema`, `output_schema`, streaming support, cancellation support, and progress events.

## Tauri Native Plugin Implications

Official Tauri 2 should be the default mobile shell experiment because native mobile functionality is expected to live in platform plugins:

| Plugin area | Android implementation | iOS implementation | Aurora contract impact |
| --- | --- | --- | --- |
| Audio capture/session | Kotlin plugin + microphone/foreground service handling. | Swift plugin + AVAudioSession/microphone handling. | Emits `listening`, `permission_denied`, `audio_level`, `session_stopped`. |
| Notifications/actions | Kotlin notifications and intent callbacks. | Swift notification actions. | Converts notification actions into typed Aurora commands. |
| Secure storage | Android keystore-backed storage through plugin. | Keychain-backed storage through plugin. | Stores tokens/device keys; never exposes secrets to arbitrary web content. |
| Assistant/App Intent integration | `RoleManager`, assist activity, optional `VoiceInteractionService`. | App Intents/App Shortcuts/SiriKit where supported. | Presents system-entry events as authenticated Aurora command envelopes. |
| Local inference | JNI/native runtime binding or process-isolated provider. | Swift/C++/Core ML/Metal provider. | Registers provider capabilities and emits progress/cancellation events. |
| Mesh transport | WebRTC/native networking where needed. | WebRTC/native networking where needed. | Exposes peer availability, trust, and route preview in capability graph. |

### Security implications

- Native plugins are privileged. Every command exposed to JavaScript/webview must have an allowlist, permission scope, argument schema, audit metadata, and failure mode.
- The webview must not get raw native secret access. Tokens and device credentials stay in native secure storage; UI receives only capability/auth status.
- Local loopback, if used on mobile, must bind to app-private channels or authenticated localhost endpoints; random local webpages/processes must not be able to invoke Aurora.
- Admin actions from mobile require the same `method_type="manage"` and permission checks as server/desktop UI.

## Capability Gating Model

Mobile UI should render feature availability from a capability graph, not hardcoded platform assumptions.

| Capability | Android gate | iOS gate | Degraded fallback |
| --- | --- | --- | --- |
| Chat / command invoke | HTTP/mesh/local transport authenticated. | HTTP/mesh/local transport authenticated. | Server/peer route only. |
| Voice session | Mic permission + native audio plugin. | Mic permission + native audio plugin. | Text-only mode. |
| System assistant entry | `ROLE_ASSISTANT` available/held or assist activity reachable. | App Shortcut / App Intent / Siri-supported domain. | In-app button, widget, notification action, share sheet. |
| Always-on / wake word | Explicit foreground/background policy, battery gate, user opt-in. | Generally non-goal; use supported system triggers. | Push-to-talk, widgets, shortcuts. |
| Local inference | Runtime installed + model downloaded + thermal/power budget. | Runtime installed + model downloaded + memory/power budget. | Remote/peer inference provider. |
| Admin/operator actions | Principal has `manage` scope; secure storage; audit available. | Principal has `manage` scope; secure storage; audit available. | Read-only status or hidden controls. |
| Mesh peer operation | Peer trust, route policy, network availability. | Peer trust, route policy, network availability. | Server route or local-only mode. |

## Experiment Plan

### Experiment M1 — Tauri mobile plugin smoke

- Build minimal Tauri 2 mobile app for Android and iOS.
- Add one Kotlin and one Swift plugin command: `getNativeCapabilityStatus()`.
- Emit one plugin event into webview.
- Acceptance: release/profile builds run on physical Android and iOS/TestFlight devices; event appears in the UI event stream abstraction.

### Experiment M2 — Android assistant role

- Implement manifest-only prototype for assist activity and optional `VoiceInteractionService` shell.
- Query `RoleManager` availability/held state and request role when available.
- Acceptance: device matrix records supported/unsupported/denied/granted; successful grant opens Aurora session from assistant affordance.

### Experiment M3 — iOS App Intent / Shortcut

- Define App Intent specs for `SendPrompt` and `StartVoiceSession`; implement a POC only after spec approval.
- Acceptance: actions appear in Shortcuts; shortcut calls authenticated Aurora endpoint or local mock; Siri invocation tested only where OS/domain supports it.

### Experiment M4 — Native audio + events

- Android/iOS plugins request mic permission, capture a short audio buffer or simulated session, emit status events.
- Acceptance: permission denied/retry/active/stopped/error states match the same UI event contract used by desktop and web.

### Experiment M5 — Local inference provider bakeoff

- Select one tiny model/task per runtime: ExecuTorch, ONNX Runtime Mobile, MLC LLM, Core ML where applicable.
- Acceptance: each candidate reports install size, model size, cold/warm latency, memory peak, thermal/power observations, cancellation, and streaming/progress capability.

### Experiment M6 — Security and policy review

- Review plugin command allowlists, storage, permissions, local network/loopback, background audio, model downloads, and telemetry/audit.
- Acceptance: each high-risk capability has a consent copy, threat model note, and store-policy disposition.

## Decision Gates

| Gate | Pass condition | Fail action |
| --- | --- | --- |
| G-Android-role | Two-device matrix proves `ROLE_ASSISTANT` query/request/invocation behavior or documents unsupported path. | Ship Android with in-app/PTT/notification/share triggers only. |
| G-Android-VIS | `VoiceInteractionService` qualifies, stays lightweight, and delegates heavy work safely. | Do not ship VIS; use role assist activity or explicit app surfaces. |
| G-iOS-intents | App Intents/App Shortcuts provide useful Siri/Shortcuts/Spotlight entry without replacement claims. | Keep iOS to app, widgets, notifications, share sheet, and manual shortcuts. |
| G-Mobile-inference | At least one provider per target task meets latency/memory/power/offline thresholds. | Route to server/peer and mark local inference unavailable. |
| G-Tauri-plugin | Kotlin/Swift plugin bridge can expose commands/events securely in release builds. | Reconsider mobile shell or build native mobile clients separately. |
| G-Python-mobile | Python-backed Tauri/PyTauri proves Aurora-relevant CPython/dependency subset on physical Android/iOS. | Keep Python-backed path desktop/prototype-only. |
| G-Store-policy | App Store / Play policy review clears background, audio, model download, privacy, and embedded runtime behavior. | Narrow capability tier or require explicit foreground use. |

## Recommended Backlog Items

1. Define `NativeMobileTransport` contract as a transport profile under the same `AuroraClient` base contract.
2. Define mobile `CapabilityStatus` schema for native permissions, role availability, intent availability, local runtime availability, battery/thermal state, and route policy.
3. Add mobile event taxonomy to SDK spec: `permission.requested`, `permission.denied`, `assistant.role.available`, `assistant.role.held`, `intent.invoked`, `audio.session.started`, `inference.download.progress`, `inference.thermal.throttled`.
4. Write Android role/VIS experiment PRD before implementation.
5. Write iOS App Intent copy/spec with exact supported/non-supported claims.
6. Write mobile inference provider benchmark protocol with device matrix and thresholds.
7. Add mobile security review checklist covering native plugin allowlists, token storage, loopback auth, audit, and privacy labels.

## Final Recommendation

Proceed with mobile/native work as a staged feasibility program:

- **Default mobile shell:** official Tauri 2 + Kotlin/Swift plugins.
- **Default iOS claim:** supported App Intents/Shortcuts/SiriKit/Spotlight integration only; no Siri replacement.
- **Default Android claim:** assistant-role integration is a gated experiment; in-app voice/PTT remains baseline.
- **Default local inference claim:** provider-based, task-specific, and route-previewed; no full desktop Python parity claim.
- **Default fallback:** every mobile feature must degrade to server/peer transport through the same AuroraClient/capability graph.

This preserves Aurora's bus-first typed-contract architecture while allowing native mobile affordances to become progressive capabilities rather than hard forks of the UI product.
