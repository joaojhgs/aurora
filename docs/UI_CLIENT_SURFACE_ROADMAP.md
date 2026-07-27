# Aurora UI client-surface roadmap

**Status:** Current source of truth

**Last reviewed:** 2026-07-26

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

The recommended direct-peer transport is WebRTC implemented once in the TypeScript/browser layer. The same implementation can run in a normal browser, a desktop Tauri WebView, and Android/iOS WebViews. Rust, Kotlin, and Swift should supply only capabilities that browsers cannot safely or durably own, such as secure credential storage, lifecycle/background services, OS integrations, and platform permission evidence.

A Rust WebRTC implementation is not the default because it would duplicate the browser implementation, require a separate WebView-to-Rust streaming bridge, and reduce cross-platform reuse. It remains a future escape hatch only if a measured platform limitation cannot be solved in the WebView.

## Current progress marker

As of 2026-07-27, the shared TypeScript/WebView WebRTC direction is no longer just roadmap work. The implemented runtime supports hosted web thin, desktop Tauri thin, Android thin, and the iOS thin source path with `http-only`, `webrtc-only`, and `webrtc-preferred` modes. Direct, configured-STUN, and forced-TURN live interop with the Python Gateway passes in Chromium, Firefox, and Playwright WebKit while the Python HTTP API is disabled. Lane classification comes from the browser `RTCPeerConnection.getStats()` selected candidate pair. Desktop and Android thin artifact proof passes without Python/sidecar content. Desktop, Android, and iOS thin packaging also accepts a WSS-only `webrtc-only` policy with no compiled HTTPS Gateway origin; a fresh desktop AppImage/deb was built and scanned in that mode. Android now has real packaged-WebView UI/native-payload E2E plus durable API 35 external-Python-peer WebRTC E2Es for both the packaged System WebView and standalone Android Chrome without CDP in the existing Android workflow. The iOS path has device-only Keychain reconnect credentials/proof, nonsecret profile storage, exact-origin Python-free overlay generation, and a macOS simulator build/install/launch/screenshot/keep-alive lane, but the new macOS gate has not run on this unpushed branch. Physical Android/iOS runtime proof, durable mobile background wakeword, production packaged-WebView network certification, and iOS signing proof remain unclaimed. See [`UI_CLIENT_SURFACE_STATUS.md`](UI_CLIENT_SURFACE_STATUS.md), [`WEBVIEW_WEBRTC_PROTOCOL_CONTRACT.md`](WEBVIEW_WEBRTC_PROTOCOL_CONTRACT.md), and [`WEBRTC_LIVE_INTEROP_HARNESS.md`](WEBRTC_LIVE_INTEROP_HARNESS.md).

## Client catalog

The following are distinct supported deployment profiles, even where they share the same UI bundle.

| ID | Client profile | Runtime and transport | Local/native scope | Target status |
| --- | --- | --- | --- | --- |
| `desktop-local` | Desktop Tauri local node | Rust-supervised Python sidecar; SDK reaches its loopback Gateway | Full local service graph where the selected sidecar profile provides it; daemon-owned wakeword/background capture; desktop secure storage and lifecycle | First-class |
| `desktop-thin-http` | Desktop Tauri remote shell over HTTP | No running Python sidecar; SDK uses HTTPS plus Gateway event streaming | Desktop shell, secure storage, tray/notifications, focused WebView microphone | First-class |
| `desktop-thin-webrtc` | Desktop Tauri direct peer shell | No Python sidecar and no Aurora HTTP application server; WebView uses WSS signaling, WebRTC DataChannel, STUN/TURN, and mesh RPC | Desktop shell, secure storage, focused WebView microphone; optional native lifecycle aids | First-class |
| `web-http` | Hosted web shell over HTTP | HTTPS site plus remote Aurora Gateway HTTP/event transport | Browser permissions, focused microphone, browser playback, PWA features where supported | First-class |
| `web-webrtc` | Hosted web direct peer shell | HTTPS site plus WSS signaling and WebRTC DataChannel to an Aurora peer; no Aurora HTTP application server required | Browser permissions, focused microphone, browser playback | First-class |
| `android-http` | Android Tauri thin shell over HTTP | HTTPS Gateway transport in Android System WebView | Keystore-backed credentials, QR/deep link, notifications, focused microphone, foreground lifecycle evidence | First-class thin client |
| `android-webrtc` | Android Tauri foreground direct peer shell | Shared WebView WebRTC transport while the app is foregrounded | Keystore, QR/deep link, microphone permission mediation, connectivity/lifecycle integration | First-class thin client |
| `android-native-enhanced` | Android capability-enhanced client | HTTP or WebRTC plus native adapters | Foreground voice service where allowed, Android assistant entry points where qualified, notifications/actions, optional lightweight on-device models | Tiered follow-on |
| `ios-http` | iOS Tauri thin shell over HTTP | HTTPS Gateway transport in WKWebView | Keychain, universal/deep links, App Intents/Shortcuts/share surfaces, focused microphone | First-class thin client |
| `ios-webrtc` | iOS Tauri foreground direct peer shell | Shared WebView WebRTC transport while the app is foregrounded | Keychain, invite handoff, microphone permission mediation, connectivity/lifecycle integration | First-class thin client |
| `ios-native-enhanced` | iOS capability-enhanced client | HTTP or WebRTC plus native adapters | App Intents, Shortcuts, share/widget surfaces, notifications, optional lightweight on-device models | Tiered follow-on |
| `pyqt-fallback` | Legacy PyQt local client | Python UIBridge and local bus | Existing local/reference workflows only | Maintained fallback, not the target for new UI work |

### What “direct peer” removes—and what it does not

A WebRTC-only thin shell removes the requirement for the client to reach an Aurora FastAPI/HTTP application server. It still requires:

- an HTTPS origin for a hosted web client and a secure WebView application origin;
- MQTT over secure WebSocket (`wss:`) or another compatible signaling service;
- STUN and, for reliable NAT traversal, TURN infrastructure;
- an invite, room, peer identity, and pairing/reconnect credentials;
- at least one compatible Aurora peer that exposes authorized capabilities.

Signaling is rendezvous, not the application data path. After negotiation, Aurora RPC, streaming responses, cancellation, and permitted events travel over the encrypted WebRTC DataChannel. TURN may relay those encrypted packets when a direct path is unavailable.

## Shared feature contract

Legend: **R** required for the profile; **N** native/platform-enhanced; **—** intentionally not part of the profile; **L** legacy-only. “Required” is a roadmap obligation, not a current-state claim.

| Capability | Desktop local | Desktop thin HTTP | Desktop thin WebRTC | Web HTTP | Web WebRTC | Android HTTP/WebRTC | iOS HTTP/WebRTC | Native-enhanced mobile | PyQt |
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
- **Desktop/web thin:** focused WebView capture can provide push-to-talk and an optional focused-page wake experience. It must not claim durable background listening.
- **Mobile thin:** focused WebView capture is valid. Durable wake/background behavior requires a native adapter and explicit OS/runtime evidence.
- **WebRTC v1:** use the existing typed Aurora RPC path for captured audio. Do not introduce WebRTC media tracks until measurements show that data-channel audio requests cannot meet latency, size, and backpressure requirements.

## Security and privacy invariants

Every supported client profile must preserve these rules:

1. UI code calls `AuroraClient`; it does not call raw Gateway routes, Tauri commands, MQTT, WebRTC, or Python services directly.
2. Service calls and events preserve typed method/topic IDs, principal identity, permission metadata, correlation IDs, selector data, and redaction rules.
3. A thin peer advertises a consumer-only or explicitly minimal manifest and rejects unsolicited inbound service calls by default.
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

### R1 — Production-grade HTTP thin shells

- Make Gateway endpoint configuration runtime-editable and persistent rather than build-time only.
- Bind Tauri HTTP authentication to the live `AuthSession`, not a static build token.
- Tailor Tauri `connect-src`, origin validation, CORS, and secure-storage policy for operator-selected remote endpoints; mode-specific packaging must not require or compile an unused Gateway origin into `webrtc-only` clients.
- Add a true no-sidecar Tauri bundle lane; verify the package contains no Python executable or Python runtime assets.
- Certify desktop thin and hosted web HTTP paths before relying on them as WebRTC fallback.

**Exit:** desktop/web thin clients work against an operator-managed HTTPS Gateway without a local Python runtime.

### R2 — Shared WebView WebRTC core

- Keep the browser-safe WebRTC module in `packages/aurora-sdk` as the single shared implementation.
- Maintain MQTT-over-WSS signaling, protocol-compatible cryptography, ICE/STUN/TURN, the `aurora-rpc` DataChannel, pairing SAS, canonical reconnect proof, authorization over public production Auth/Gateway/DataChannel boundaries, RPC/stream/cancel, peer manifests, fragmentation/backpressure, and scoped events.
- Keep `WebRtcMeshPeerBridge` behind `MeshP2PTransport` so UI code sees only `AuroraClient` and the typed peer-session controller.
- Preserve the live Chromium/Firefox/Playwright-WebKit direct, configured-STUN, and forced-TURN browser-to-Python harness with the Python HTTP API disabled.
- Extend all engines to production TURN plus longer soak/load lanes before broader browser claims.

**Current exit:** achieved for direct/configured-STUN/forced-TURN Chromium, Firefox, and Playwright-WebKit interop; not achieved for packaged WebViews or production network scale.

### R3 — Hosted web direct-peer client

- Keep `NEXT_PUBLIC_AURORA_CONNECTION_MODE=http-only|webrtc-only|webrtc-preferred` as the hosted web selection surface.
- Keep browser imports SSR-safe and lazy; require secure contexts for microphone/WebRTC.
- Maintain invite import, SAS confirmation, reconnect UX, TURN diagnostics, route badges, encrypted IndexedDB secret storage, validated nonsecret profile/stable-ID metadata, automatic refresh re-dial, and explicit memory-only fallback when persistence is unavailable.
- Add user-verified WebAuthn PRF/passkey vault unlock and a public-key reconnect challenge so the browser no longer needs a reusable persisted bearer.
- Preserve Chromium, Firefox, and Playwright-WebKit direct/STUN/TURN behavior; validate page visibility/suspension limits before broader cross-browser release claims.

**Current exit:** achieved for direct Chromium/Firefox/WebKit foreground operation against a Python peer without the Aurora HTTP application server; broader certification remains pending.

### R4 — Desktop Tauri direct-peer client

- Reuse the exact WebView WebRTC implementation.
- Keep native secure-store/proof adapter, remote-origin policy, tray/connectivity status, and microphone permission evidence narrow and evidence-backed.
- Ship no-sidecar artifacts distinct from all local Python bundle profiles and verify AppImage/deb contents.
- Preserve desktop-local selection and wakeword ownership without transport-specific checks scattered through UI screens.

**Current exit:** desktop thin profiles and Python-free AppImage/deb artifact proof pass, including a WSS-only `webrtc-only` package with no Gateway origin; desktop-local remains separate. Live desktop WebView WebRTC smoke is still separate from the shared browser-engine harness.

### R5 — Android and iOS foreground thin clients

- Reuse the shared WebView transport and peer-session controller.
- Keep Android QR/deep-link, Keystore peer credential/proof, explicit WebView microphone permission mediation, lifecycle release policy, and foreground/resume/reconnect behavior evidence-backed.
- Preserve the implemented Android/iOS mode-specific Python-free wrappers, including WSS-only `webrtc-only` builds, plus the iOS Keychain/profile/proof integration; add packaged WebView runtime evidence before claiming live mobile WebRTC support.
- Keep the Android API 30/API 35 packaged UI/native-payload E2E plus both API 35 WebRTC peers in the existing Android pipeline: the packaged System WebView and the standalone Android mobile browser must each pair with an external Python peer. The mobile tests must consume the same negotiation-direction, manifest, error, 512 KiB fragmentation, stream/cancel, pairing, RPC/event, reconnect, revocation, HTTP-disabled, and redaction assertions as browser interop; do not split their individual assertions into extra PR checks.
- Do not claim durable background WebRTC, wakeword, or audio capture until native services and OS behavior are separately proven.
- Run physical-device tests across direct, STUN, and TURN-relayed paths.

**Current exit:** Android thin build/artifact and native-policy proof exist; packaged UI/native payload passes on the local API 30 emulator, and the KVM-backed API 35 CI lane now owns both packaged-WebView and no-CDP Android-browser ↔ Python WebRTC interop. A fresh CI run of those gates and physical/OEM proof remain pending. iOS thin source/permission/Keychain/profile wiring plus an exact-origin simulator build/runtime lane exist; a fresh macOS/Xcode run and WKWebView/physical direct-STUN-TURN interop are still pending.

### R6 — Native-enhanced mobile capabilities

- Add only evidence-backed native capabilities: notification actions, Android foreground voice service/assistant entry points where qualified, iOS App Intents/Shortcuts/share/widget surfaces, and platform audio adapters.
- Introduce lightweight local STT/TTS/embedding/inference providers behind capability contracts where device, thermal, storage, and model-license gates pass.
- Keep unsupported capabilities explicit; never infer them from the presence of native plugin skeletons.

**Exit:** each native capability has physical-device evidence, lifecycle limits, permission state, privacy behavior, and fallback UX.

### R7 — Release certification and parity

- Run cross-surface route, accessibility, auth, redaction, reconnect, NAT/TURN, lifecycle, package-content, upgrade, and rollback suites.
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
