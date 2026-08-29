# Aurora UI client-surface roadmap

**Status:** Current source of truth

**Last reviewed:** 2026-07-30

**Audience:** product, frontend, SDK, Gateway, mesh, mobile, packaging, and release contributors

This document defines the complete target client catalog for Aurora's shared UI, the cross-surface feature contract, and the order in which the supported clients should become release-ready. It describes **target capability**, not current implementation readiness. Read [`UI_CLIENT_SURFACE_STATUS.md`](UI_CLIENT_SURFACE_STATUS.md) for the evidence-based current state.

## Product direction

Aurora should ship one SDK-first React UI across browser and WebView shells. Runtime differences are represented by a centralized surface profile and selected transports, not by separate product forks:

```text
Shared Aurora React UI
  -> getAuroraSurfaceProfile()
  -> AuroraClient
       -> HTTP Gateway transport
       -> WebView WebRTC mesh transport
       -> Tauri local command/Gateway bridge
       -> native platform capability adapters
  -> typed Aurora service and event contracts
```

The direct-peer transport keeps signaling, session/roster orchestration, pairing
flow, RPC, and routing in the shared TypeScript/WebView layer. Grant evaluation,
execution policy, reconnect challenges, and revocation use the Rust mesh
authority on Tauri and the same core through WebAssembly in browsers. Native
Rust/Kotlin/Swift also own secure storage, lifecycle/background services, OS
integrations, and platform permission evidence; Android's bound Rust mesh
session handles the bounded work that must survive a frozen WebView.

A full Rust Aurora WebRTC protocol remains rejected because it would duplicate signaling/auth/mesh behavior and reduce cross-platform reuse. One measured exception now exists: common Linux WebKitGTK packages can omit the `RTCPeerConnection` DOM feature. The desktop client therefore injects a narrow Rust `webrtc-rs` peer-connection/DataChannel primitive only when that browser API is absent; the TypeScript protocol above it is unchanged.

Current runtime-role model separates these axes:

- **Surface:** hosted web, desktop Tauri, Android Tauri, iOS Tauri, or PyQt fallback.
- **Node mode:** remote console, mesh node, or full local node when the desktop package includes the Python sidecar.
- **Transport:** HTTP, WebRTC, or WebRTC-preferred with explicit HTTP fallback for new calls.
- **Runtime tier:** Python full service graph or bounded TypeScript/native lightweight capabilities.
- **Authority:** authenticated home-node session authority and peer-specific inbound grants remain distinct from pairing.
- **Capability packs:** local tools and native actions advertise only after platform capability evidence plus user enablement.
- **Lifecycle:** hosted web and mobile WebViews are foreground peers; durable background behavior requires platform-native support and evidence.

Python-free artifacts now use neutral `client` command names (`desktop-client`,
Android client, iOS client, hosted peer). Legacy `thin` command names remain as
compatibility aliases while older branch protection and release scripts are
retired.

## Current progress marker

As of 2026-08-24, the shared WebView WebRTC direction is implemented as runtime-role work rather than only roadmap work. The runtime supports hosted web, desktop Tauri client, Android client, and the iOS source path with `http-only`, `webrtc-only`, and `webrtc-preferred` modes. Runtime profiles select remote-console or mesh-node behavior independently from physical surface. Mesh-node profiles have a per-peer session registry/router, while Connect profiles remain single-home-peer. Python remains the full authoritative service runtime; Rust is the single mesh grant/permission authority on native and through WebAssembly on web.

Direct, configured-STUN, and forced-TURN live interop with the Python Gateway passes in Chromium, Firefox, and Playwright WebKit while the Python HTTP API is disabled. The hosted Chromium product-flow gate, hosted mesh-node gate, and web persistence gate also pass against a real Python peer and prove invite-first onboarding, bilateral approval, scoped WebRTC route/Mesh reads, zero browser Gateway HTTP fallback, encrypted browser persistence, and reload reconnect. Desktop Linux substitutes a package-local Rust peer primitive when WebKitGTK lacks `RTCPeerConnection`; TypeScript keeps protocol/session orchestration while the Rust authority owns permission decisions. The packaged Linux desktop live E2E passes with runtime invite, bilateral matching SAS, scoped non-admin authorization, native Rust fallback, distinct role-switch sessions, restart/reconnect, revocation fail-closed, no Python child process or sidecar, and zero forbidden compiled endpoints/secrets. Desktop, Android, and iOS client packaging uses runtime-configurable endpoint profiles instead of compiling operator Gateway/signaling URLs into artifacts.

Remaining release-readiness proof is platform-bound. Packaged Linux desktop live E2E is proven, but packaged macOS and Windows live proof remains external platform evidence. Android source/build/APK/AAB gates and API 30 launch smoke pass. Waydroid full-stack acceptance also passes against the real Python service for pairing, background native ping/tool serving, ordered resume, force-stop/server-restart recovery, and assistant turns. Waydroid does not establish physical Doze, OEM kill policy, battery/thermal behavior, signing/store readiness, or every direct/STUN/TURN radio path. iOS policy/source/frontend/overlay checks pass on Linux, but simulator, MobileSafari, packaged WKWebView, Swift runtime smoke, signing, and App Store evidence require macOS/Xcode. Durable mobile background wakeword remains unclaimed. See [`UI_CLIENT_SURFACE_STATUS.md`](UI_CLIENT_SURFACE_STATUS.md), [`WEBVIEW_WEBRTC_PROTOCOL_CONTRACT.md`](WEBVIEW_WEBRTC_PROTOCOL_CONTRACT.md), [`mesh/THIN-CLIENT-MESH-PARITY-PLAN.md`](mesh/THIN-CLIENT-MESH-PARITY-PLAN.md), and [`mesh/BACKGROUND-MEASUREMENT.md`](mesh/BACKGROUND-MEASUREMENT.md).

## Client catalog

The following are distinct supported deployment profiles, even where they share the same UI bundle.

| ID | Client profile | Runtime and transport | Local/native scope | Target status |
| --- | --- | --- | --- | --- |
| `desktop-local` | Desktop Tauri local node | Rust-supervised Python sidecar; SDK reaches its loopback Gateway | Full local service graph where the selected sidecar profile provides it; daemon-owned wakeword/background capture; desktop secure storage and lifecycle | First-class |
| `desktop-client-http` | Desktop Tauri remote shell over HTTP | No running Python sidecar; SDK uses HTTPS plus Gateway event streaming | Desktop shell, secure storage, tray/notifications, focused WebView microphone | First-class |
| `desktop-client-webrtc` | Desktop Tauri direct peer shell | No Python sidecar and no Aurora HTTP application server; WSS signaling and the shared TypeScript mesh/RPC runtime use WebView WebRTC on macOS/Windows or the narrow native peer primitive on Linux when WebKitGTK omits it | Desktop shell, secure storage, focused WebView microphone; optional native lifecycle aids | First-class |
| `web-http` | Hosted web shell over HTTP | HTTPS site plus remote Aurora Gateway HTTP/event transport | Browser permissions, focused microphone, browser playback, PWA features where supported | First-class |
| `web-webrtc` | Hosted web direct peer shell | HTTPS site plus WSS signaling and WebRTC DataChannel to an Aurora peer; no Aurora HTTP application server required | Browser permissions, focused microphone, browser playback | First-class |
| `android-http` | Android Tauri client shell over HTTP | HTTPS Gateway transport in Android System WebView | Keystore-backed credentials, QR/deep link, notifications, focused microphone, foreground lifecycle evidence | First-class client |
| `android-webrtc` | Android Tauri foreground direct peer shell | Shared WebView WebRTC transport while the app is foregrounded | Keystore, QR/deep link, microphone permission mediation, connectivity/lifecycle integration | First-class client |
| `android-native-enhanced` | Android capability-enhanced client | HTTP or WebRTC plus native adapters | Foreground voice service where allowed, Android assistant entry points where qualified, notifications/actions, optional lightweight on-device models | Tiered follow-on |
| `ios-http` | iOS Tauri client shell over HTTP | HTTPS Gateway transport in WKWebView | Keychain, universal/deep links, App Intents/Shortcuts/share surfaces, focused microphone | First-class client |
| `ios-webrtc` | iOS Tauri foreground direct peer shell | Shared WebView WebRTC transport while the app is foregrounded | Keychain, invite handoff, microphone permission mediation, connectivity/lifecycle integration | First-class client |
| `ios-native-enhanced` | iOS capability-enhanced client | HTTP or WebRTC plus native adapters | App Intents, Shortcuts, share/widget surfaces, notifications, optional lightweight on-device models | Tiered follow-on |
| `pyqt-fallback` | Legacy PyQt local client | Python UIBridge and local bus | Existing local/reference workflows only | Maintained fallback, not the target for new UI work |

### What “direct peer” removes—and what it does not

A WebRTC-only client removes the requirement for the client to reach an Aurora FastAPI/HTTP application server. It still requires:

- an HTTPS origin for a hosted web client and a secure WebView application origin;
- MQTT over secure WebSocket (`wss:`) or another compatible signaling service;
- STUN and, for reliable NAT traversal, TURN infrastructure;
- an invite, room, peer identity, and pairing/reconnect credentials;
- at least one compatible Aurora peer that exposes authorized capabilities.

Signaling is rendezvous, not the application data path. After negotiation, Aurora RPC, streaming responses, cancellation, and permitted events travel over the encrypted WebRTC DataChannel. TURN may relay those encrypted packets when a direct path is unavailable.

## Shared feature contract

Legend: **R** required for the profile; **N** native/platform-enhanced; **—** intentionally not part of the profile; **L** legacy-only. “Required” is a roadmap obligation, not a current-state claim.

| Capability | Desktop local | Desktop client HTTP | Desktop client WebRTC | Web HTTP | Web WebRTC | Android HTTP/WebRTC | iOS HTTP/WebRTC | Native-enhanced mobile | PyQt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Shared assistant workspace | R | R | R | R | R | R | R | R | L |
| Shared operator/admin routes, permission-scoped | R | R | R | R | R | R | R | R | L |
| Typed SDK-only UI boundary | R | R | R | R | R | R | R | R | — |
| Dynamic runtime capability discovery | R | R | R | R | R | R | R | R | — |
| HTTP request/query transport | R (loopback) | R | Optional fallback | R | Optional fallback | R in HTTP mode | R in HTTP mode | R in HTTP mode | — |
| HTTP event streaming | R (loopback) | R | Optional fallback | R | Optional fallback | R in HTTP mode | R in HTTP mode | R in HTTP mode | — |
| WebRTC peer RPC over `aurora-rpc` DataChannel | Optional peer route | — | R | — | R | R in peer mode | R in peer mode | R in peer mode | — |
| WebRTC streamed results, cancellation, and events | Optional peer route | — | R | — | R | R in peer mode | R in peer mode | R in peer mode | — |
| MQTT/WSS signaling, ICE, STUN, and TURN | Optional peer route | — | R | — | R | R in peer mode | R in peer mode | R in peer mode | — |
| Pairing SAS, identity binding, authorization, reconnect proof | Optional peer route | — | R | — | R | R in peer mode | R in peer mode | R in peer mode | — |
| QR/deep-link invite onboarding | Optional | Optional | R | Link/import | Link/import | R | R | R | — |
| Runtime-editable endpoint or peer configuration | R | R | R | R | R | R | R | R | — |
| Focused push-to-talk and waveform | R (WebView-owned) | R | R | R | R | R | R | R | L |
| Daemon/native wakeword and durable background capture | R (Python daemon) | — | — | — | — | N where OS permits | N where OS permits | N | L |
| Assistant text streaming | R | R | R | R | R | R | R | R | L |
| Client-side TTS playback | Optional | R | R | R | R | R | R | R | L |
| OS credential storage | R | R | R | — | — | R | R | R | — |
| Safe browser credential posture | — | — | — | R | R | — | — | — | — |
| Connection/pairing diagnostics and route badge | R | R | R | R | R | R | R | R | — |
| Offline/full local Python services | R by bundle profile | — | — | — | — | — | — | — | L |
| Lightweight on-device inference | — | — | — | — | — | Optional later | Optional later | N | — |
| Tray/global shortcuts/desktop notifications | R | R | R | — | — | — | — | — | — |
| Mobile notifications, share, intents/shortcuts | — | — | — | — | — | N | N | N | — |
| Real no-sidecar package artifact | — | R | R | N/A | N/A | R | R | R | N/A |
| Signed/store-ready release evidence | R | R | R | Deployment-specific | Deployment-specific | R | R | R | — |

## Voice ownership contract

Voice behavior must remain surface-aware and centralized in `packages/aurora-ui/src/platform-surface.ts`.

- **Desktop local:** focused push-to-talk and waveform capture belong to the WebView when available; durable wakeword/background capture remains owned by `STTCoordinator` in the Python node.
- **Desktop/web client:** focused WebView capture can provide push-to-talk and an optional focused-page wake experience. It must not claim durable background listening.
- **Mobile client:** focused WebView capture is valid. Durable wake/background behavior requires a native adapter and explicit OS/runtime evidence.
- **WebRTC v1:** use the existing typed Aurora RPC path for captured audio. Do not introduce WebRTC media tracks until measurements show that data-channel audio requests cannot meet latency, size, and backpressure requirements.

## Security and privacy invariants

Every supported client profile must preserve these rules:

1. UI code calls `AuroraClient`; it does not call raw Gateway routes, Tauri commands, MQTT, WebRTC, or Python services directly.
2. Service calls and events preserve typed method/topic IDs, principal identity, permission metadata, correlation IDs, selector data, and redaction rules.
3. A client peer advertises a consumer-only or explicitly minimal manifest and rejects unsolicited inbound service calls by default.
4. A peer invite pins the expected stable peer identity. Room membership alone is not trust.
5. Production signaling uses `wss:`; hosted browser clients use HTTPS. Insecure loopback schemes are development-only.
6. Long-lived peer secrets are never placed in logs, URLs, query strings, browser `localStorage`, or browser `sessionStorage`.
7. Hosted-browser reconnect/room material is encrypted with a non-extractable origin-scoped WebCrypto key before IndexedDB persistence and falls back to memory-only when durable storage is unavailable. Tauri/mobile credentials use native OS stores and should use native proof/signing commands when practical rather than returning long-lived secrets to arbitrary UI code. Native reconnect proof commands must use the canonical `mesh_auth_proof_v1` HMAC message shared by Python/TypeScript fixtures, including Python-compatible ASCII escaping for Unicode transcript values.
8. Event delivery is peer-scoped and subscription-aware before sensitive streams such as audio are considered release-ready.
9. Transport fallback never blindly replays an in-flight mutation. Current proof covers an uncertain-loss window where a mutation start event is observed, the transport disconnects before the response settles, and execution count remains one; it is not a broad exactly-once guarantee.
10. Diagnostics expose state and correlation IDs without revealing tokens, room passwords, pairing material, raw audio, or unredacted tool payloads.

## Delivery roadmap

### R0 — Contract and truth baseline

- Keep this roadmap, [`UI_CLIENT_SURFACE_STATUS.md`](UI_CLIENT_SURFACE_STATUS.md), [`FRONTEND_AND_UI_ARCHITECTURE.md`](FRONTEND_AND_UI_ARCHITECTURE.md), and [`FEATURE_MATRIX.md`](FEATURE_MATRIX.md) aligned.
- Freeze and document the Python WebRTC signaling, cryptography, pairing, reconnect, RPC, stream, cancellation, and event envelopes as a versioned interoperability contract.
- Generate Python-owned golden fixtures and consume them from TypeScript conformance tests.
- Add capability negotiation so protocol evolution is explicit and backward compatible.

**Exit:** every WebView implementation task can cite a stable wire contract and a current readiness boundary.

### R1 — Production-grade HTTP client shells

- Keep Gateway/signaling endpoint configuration runtime-editable and
  persistent; client artifacts must never compile an operator endpoint.
- Keep first-run onboarding ahead of the normal shell until a valid profile is
  saved from a node name plus invite/QR/file/deep link. Keep manual connection
  mode, endpoint, profile-name, and stable-peer controls in post-onboarding
  settings rather than the first-run gate.
- Bind Tauri HTTP authentication to the live `AuthSession`, not a static build token.
- Keep Tauri `connect-src` general enough for runtime HTTP/HTTPS/WS/WSS
  selection while preserving URL validation, secret-query rejection, native
  secure storage, and explicit hosted-browser mixed-content/CORS limits.
- Add a true no-sidecar Tauri bundle lane; verify the package contains no Python executable or Python runtime assets.
- Certify desktop client and hosted web HTTP paths before relying on them as WebRTC fallback.

**Current exit:** runtime profile/onboarding and Python-free desktop/Android
package proof are implemented. Live operator endpoint, signed release, and
physical-device certification remain deployment evidence rather than source
claims.

### R2 — Shared WebView WebRTC core

- Keep the browser-safe WebRTC protocol in `packages/aurora-sdk` as the single shared implementation; platform peer-connection factories must remain narrow injected primitives.
- Maintain MQTT-over-WSS signaling, protocol-compatible cryptography, ICE/STUN/TURN, the `aurora-rpc` DataChannel, pairing SAS, canonical reconnect proof, authorization over public production Auth/Gateway/DataChannel boundaries, RPC/stream/cancel, peer manifests, fragmentation/backpressure, and scoped events.
- Keep `WebRtcMeshPeerBridge` behind `MeshP2PTransport` so UI code sees only `AuroraClient` and the typed peer-session controller.
- Preserve the live Chromium/Firefox/Playwright-WebKit direct, configured-STUN, and forced-TURN browser-to-Python harness with the Python HTTP API disabled.
- Extend all engines to production TURN plus longer soak/load lanes before broader browser claims.

**Current exit:** achieved for direct/configured-STUN/forced-TURN Chromium, Firefox, and Playwright-WebKit interop; not achieved for packaged WebViews or production network scale.

### R3 — Hosted web direct-peer client

- Keep hosted web endpoint and connection-mode selection in the saved runtime onboarding profile.
- Keep browser imports SSR-safe and lazy; require secure contexts for microphone/WebRTC.
- Maintain invite import, SAS confirmation, reconnect UX, TURN diagnostics, route badges, encrypted IndexedDB secret storage, validated nonsecret profile/stable-ID metadata, automatic refresh re-dial, and explicit memory-only fallback when persistence is unavailable.
- Add user-verified WebAuthn PRF/passkey vault unlock and a public-key reconnect challenge so the browser no longer needs a reusable persisted bearer.
- Preserve Chromium, Firefox, and Playwright-WebKit direct/STUN/TURN behavior; validate page visibility/suspension limits before broader cross-browser release claims.

**Current exit:** achieved for direct Chromium/Firefox/WebKit foreground protocol operation against a Python peer without the Aurora HTTP application server. The hosted Chromium product-flow gate also proves invite onboarding, bilateral scoped pairing, real route/Mesh reads, SPA navigation, blur-event survival, encrypted persistence, and reload reconnection with no browser Gateway HTTP fallback. Actual OS page suspension and broader deployment certification remain pending.

### R4 — Desktop Tauri direct-peer client

- Reuse the exact TypeScript WebRTC protocol. Use the browser peer primitive on macOS/Windows and the Linux native primitive only when `globalThis.RTCPeerConnection` is absent.
- Keep native secure-store/proof adapter, remote-origin policy, tray/connectivity status, and microphone permission evidence narrow and evidence-backed.
- Ship no-sidecar artifacts distinct from all local Python bundle profiles and verify AppImage/deb contents.
- Preserve desktop-local selection and wakeword ownership without transport-specific checks scattered through UI screens.

**Current exit:** desktop client profiles, Python-free AppImage/deb artifact
proof, and packaged Linux native-fallback live E2E pass with
endpoint-agnostic HTTP/HTTPS/WS/WSS policy; desktop-local remains separate.
Packaged macOS and Windows WebView network proof remains external platform
evidence.

### R5 — Android and iOS foreground clients

- Reuse the shared WebView transport and peer-session controller.
- Keep Android QR/deep-link, Keystore peer credential/proof, explicit WebView microphone permission mediation, lifecycle release policy, and foreground/resume/reconnect behavior evidence-backed.
- Preserve the implemented Android/iOS Python-free wrappers with
  endpoint-agnostic HTTP/HTTPS/WS/WSS policy, first-run runtime onboarding, and
  iOS Keychain/profile/proof integration; keep packaged WebView runtime
  evidence fail-closed before claiming live mobile WebRTC support.
- Keep the Android API 30/API 35 packaged UI/native-payload E2E plus both API 35 WebRTC peers in the existing Android pipeline: the packaged System WebView and the standalone Android mobile browser must each pair with an external Python peer. The mobile tests must consume the same negotiation-direction, manifest, error, 512 KiB fragmentation, stream/cancel, pairing, RPC/event, reconnect, revocation, HTTP-disabled, and redaction assertions as browser interop; do not split their individual assertions into extra PR checks.
- Keep iOS MobileSafari and the packaged Tauri WKWebView ↔ external-Python direct-path tests in the existing macOS iOS workflow and on the same shared assertion/scanner contract. Store separate reports for each surface without creating separate PR checks. Treat both as simulator evidence; physical-device direct/STUN/TURN remains a separate gate.
- Do not claim durable background WebRTC, wakeword, or audio capture until native services and OS behavior are separately proven.
- Run physical Android and iOS device tests that pair each mobile client with
  an external Python peer across direct, STUN, and TURN-relayed paths.

**Current exit:** Android source/native-policy/bundle/generated-project/preflight,
debug APK, universal debug AAB, and API 30 launch gates pass. Waydroid also
passes the packaged full-stack pairing, background native serving, ordered
resume, force-stop/server-restart recovery, and assistant-role path against the
real Python service. The KVM-backed API 35 CI lane still owns the dedicated
packaged-WebView and no-CDP Android-browser direct/STUN/TURN matrix, and physical
device power/survival evidence remains pending. iOS source, permission,
Keychain/profile wiring, and Linux-safe frontend/policy/overlay gates pass; the
macOS job owns MobileSafari and packaged-Tauri-WKWebView runtime evidence.

### R6 — Native-enhanced mobile capabilities

- Add only evidence-backed native capabilities: notification actions, Android foreground voice service/assistant entry points where qualified, iOS App Intents/Shortcuts/share/widget surfaces, and platform audio adapters.
- Introduce lightweight local STT/TTS/embedding/inference providers behind capability contracts where device, thermal, storage, and model-license gates pass.
- Keep unsupported capabilities explicit; never infer them from the presence of native plugin skeletons.

**Exit:** each native capability has physical-device evidence, lifecycle limits, permission state, privacy behavior, and fallback UX.

### R7 — Release certification and parity

- Run cross-surface route, accessibility, auth, redaction, reconnect, NAT/TURN, lifecycle, package-content, upgrade, and rollback suites.
- Keep the five rollout controls explicit and reversible: the hosted/Tauri legacy client-entry gate, scoped-subscription, fragmentation/backpressure, and app-layer-E2EE gates plus the Gateway legacy-event compatibility gate. A client-entry kill-switch test must preserve HTTP/desktop-local operation and stored credentials; E2EE-required profiles must never downgrade.
- Publish a release matrix that distinguishes automated harness proof from signed artifact, store, and physical-device proof.
- Gate public “supported” claims on the evidence in [`UI_CLIENT_SURFACE_STATUS.md`](UI_CLIENT_SURFACE_STATUS.md).

**Exit:** each advertised client has a reproducible build, supported configuration, tested transport, security posture, and documented limitations.

## Cross-surface definition of done

A client profile moves from roadmap to supported only when all applicable items are true:

- install/build/deploy instructions are reproducible;
- runtime selection and onboarding work without rebuilding the UI;
- authentication, pairing, permissions, and secret storage are proven;
- assistant request, token streaming, cancellation, and client playback work;
- supported admin routes remain permission-scoped and SDK-only;
- direct-peer clients pass Python interoperability and TURN relay tests;
- capability and limitation copy comes from centralized surface/native evidence;
- errors, reconnect state, route selection, and diagnostics are usable;
- logs and support bundles pass redaction checks;
- artifact contents match the profile, including absence of Python in no-sidecar builds;
- automated tests and required physical-device/signed-release evidence are recorded in the current status document.

## Related sources

- [`UI_CLIENT_SURFACE_STATUS.md`](UI_CLIENT_SURFACE_STATUS.md) — current implementation and validation snapshot.
- [`FRONTEND_AND_UI_ARCHITECTURE.md`](FRONTEND_AND_UI_ARCHITECTURE.md) — SDK/UI boundary and platform contracts.
- [`FEATURE_MATRIX.md`](FEATURE_MATRIX.md) — repository-wide readiness overview.
- [`TAURI_DESKTOP_BUILD.md`](TAURI_DESKTOP_BUILD.md) — current desktop packaging behavior.
- [`WEBVIEW_WEBRTC_PROTOCOL_CONTRACT.md`](WEBVIEW_WEBRTC_PROTOCOL_CONTRACT.md) — implemented WebView/Python WebRTC protocol contract.
- [`WEBRTC_LIVE_INTEROP_HARNESS.md`](WEBRTC_LIVE_INTEROP_HARNESS.md) — live Chromium/Firefox/Playwright-WebKit direct, configured-STUN, and forced-TURN interop harness and report schema.
- [`GATEWAY.md`](GATEWAY.md), [`PEER_PAIRING_FLOW.md`](PEER_PAIRING_FLOW.md), and [`AUTH_AND_PERMISSIONS.md`](AUTH_AND_PERMISSIONS.md) — server/peer protocol and authority boundaries.
