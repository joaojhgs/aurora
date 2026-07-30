# Frontend and UI architecture

**Status:** Current source of truth

Aurora's production UI architecture is SDK-first. Screens consume normalized `AuroraClient` state and call SDK methods; they do not call Python services, raw Gateway `fetch`, Tauri `invoke`, WebRTC internals, or PyQt bridge objects directly.

## Surfaces

| Surface | Path | Role |
| --- | --- | --- |
| TypeScript SDK | `packages/aurora-sdk` | Transport-independent client, fixtures, events, permissions, policy, tools, scheduler, backup, mesh, HTTP, Tauri, and mock transports. |
| Shared React UI | `packages/aurora-ui` | Production components and screens that depend on SDK state/contracts. |
| Web shell | `apps/aurora-web` | Browser/Next shell that hosts shared UI and uses Gateway-compatible SDK transport. |
| Tauri shell | `apps/aurora-tauri` | Desktop/mobile native shell, Rust command bridge, secure storage posture, sidecar supervision, and platform plugin skeletons. |
| PyQt fallback | `app/ui/bridge_service.py` | Legacy local fallback/reference for current bus behavior; not the preferred surface for new production screens. |

## Boundary rule

```text
React screen
  -> @aurora/client method/event API
  -> selected SDK transport
  -> Gateway HTTP/SSE, Tauri command bridge, mock transport, or mesh bridge
  -> Aurora bus/service contract
```

Production UI files must stay on the SDK side of this boundary. Tests in `packages/aurora-ui` and `packages/aurora-sdk` enforce that screens do not directly call backend transports.

See [`PRODUCTION_UI_CONTRACTS.md`](PRODUCTION_UI_CONTRACTS.md).

## SDK transports

| Transport | Purpose |
| --- | --- |
| HTTP/Gateway | Web and remote clients use Gateway routes and event streams. |
| Tauri local/native | Desktop local mode can call narrow Rust commands that supervise the Python sidecar or proxy Gateway-compatible requests. |
| Mock/test | Package tests and visual/resilience suites. |
| Mesh/WebRTC bridge | Interface over peer RPC/capability routing. `MeshP2PTransport`, `WebRtcMeshPeerBridge`, and browser/WebView WebRTC runtime exist under `@aurora/client/webrtc`; direct, configured-STUN, and forced-TURN browser-to-Python live interop is proven in Chromium, Firefox, and Playwright WebKit. |

The SDK preserves method IDs, bus topics, selector/audit metadata, redaction information, and backend evidence. Tauri IPC and mock transports are not independent sources of truth for service state.

## Client-surface roadmap and present boundary

The complete target client catalog and cross-surface feature checklist live in [`UI_CLIENT_SURFACE_ROADMAP.md`](UI_CLIENT_SURFACE_ROADMAP.md). The evidence-based current implementation boundary lives in [`UI_CLIENT_SURFACE_STATUS.md`](UI_CLIENT_SURFACE_STATUS.md).

The runtime-role work is now represented as separate axes instead of a transport-specific client label:

- `packages/aurora-ui/src/runtime-profile.ts` owns the versioned runtime profile, including node mode, runtime tier, home-node connection, local-node identity, mesh membership, and enabled capability packs. Version-1 connection profiles migrate to remote-console profiles.
- `packages/aurora-ui/src/platform-surface.ts` remains the single source for physical surface capabilities. Screens should consume its capability flags and the runtime profile; they should not infer role from HTTP, WebRTC, Tauri, Android, or iOS checks scattered through components.
- `packages/aurora-sdk/src/peer-host/`, `packages/aurora-sdk/src/local-tools/`, and `packages/aurora-sdk/src/lightweight-orchestrator/` own the bounded TypeScript mesh-node host, local Tooling provider, and optional device assistant tier. Python remains the full authoritative service runtime.
- `packages/aurora-sdk/src/local-data/` and `packages/aurora-ui/src/local-data/` own the lightweight local-data repository boundary. The lightweight database is separate from Python service databases and exposes typed repositories only; no public SDK, UI, mesh, or native command accepts arbitrary SQL.
- `apps/aurora-tauri/src/aurora-client.ts` composes the production Tauri runtime from the saved profile and optional native assistant provider. Provider secrets stay behind Rust/native secure storage; JavaScript receives status/proof/catalog surfaces instead of raw credentials.
- The browser clear-device-data lifecycle is scoped to Aurora-owned client data. It removes the scoped Aurora peer vault/profile metadata, selected local-data backend pointer, storage lease, envelope-key database, local-data IndexedDB database, and OPFS node directory, while preserving unrelated same-origin data. A structured partial failure is not success and must keep reporting the affected cleanup step.

The selected direct-peer direction is implemented as one TypeScript WebRTC runtime in the SDK/browser layer, reused by hosted web and desktop/mobile WebViews. Rust, Kotlin, and Swift remain narrow adapters for secure storage, permissions, lifecycle/background behavior, OS integrations, and optional native model runtimes. Current live proof covers Chromium, Firefox, and Playwright-WebKit direct, configured-STUN, and forced-TURN browser-to-Python Gateway sessions over MQTT signaling and the `aurora-rpc` DataChannel with the Python HTTP API disabled. Separate hosted-Chromium UI, hosted mesh-node, and web persistence E2Es start the real Python service and Next shell, import a runtime invite, prove matching bilateral SAS approval with a scoped non-admin principal, exercise large registry/catalog and Mesh reads over the DataChannel with zero browser Gateway HTTP requests, survive the runtime's blur event, and reconnect after reload from encrypted IndexedDB state without pairing again. Packaged Linux desktop live E2E also passes with the native Rust WebRTC fallback, Python HTTP API disabled, role switching, restart/reconnect, revocation fail-closed, no Python child process or sidecar, and no compiled endpoints or secrets. This is foreground browser plus packaged Linux desktop evidence, not OS page-suspension, packaged macOS/Windows, or physical mobile proof. Android packaged-WebView/Chrome and iOS MobileSafari/packaged-Tauri-WKWebView simulator gates are wired into their existing platform jobs and reuse the same external-Python pairing contract, but await usable Android KVM/device access and macOS/Xcode iOS runs. Physical mobile proof remains unclaimed.

The shared runtime also owns rollout behavior. Hosted web reads
`NEXT_PUBLIC_AURORA_WEBRTC_*` gates and Tauri reads matching
`VITE_AURORA_WEBRTC_*` gates for the Python-free client entry point, scoped
subscriptions, fragmentation/backpressure, and optional app-layer E2EE. The
main kill switch leaves HTTP and desktop-local factories intact:
`webrtc-preferred` selects configured HTTP without consuming or rewriting peer
credentials, while `webrtc-only` fails closed. Capability gates are carried in
the local protocol hello and therefore take effect only through the
Python/TypeScript negotiated intersection. A profile that requires
application-layer E2EE never downgrades to plaintext.

## Assistant streaming and voice playback

Assistant screens consume `AuroraClient.assistant.streamMessage(...)` and `streamVoiceAssistantResponses(...)`. Those helpers subscribe to `Orchestrator.Response` for token/tool state and `TTS.AudioChunk` for streamed speech, then normalize everything into `AssistantStreamUpdate`. Shared UI components should render only SDK updates.

Platform playback rules:

- Desktop local daemon/STT requests keep wakeword and background capture in Python services. The orchestrator starts `TTS.StreamStart` with `play_on_server=true`, so the local TTS service speaks even if the WebView is minimized.
- Desktop client, hosted web, and mobile push-to-talk/read-aloud paths use client playback from `TTS.AudioChunk` events unless a native bridge later advertises a tested playback surface.
- UI-origin text messages do not auto-read responses unless runtime config enables the UI assistant readback preference.
- Tool-call cards must use redacted stream previews from the SDK; no component may display raw tool args, tokens, audio, or unredacted support data.

## Tauri desktop roles and modes

| Role/mode | Behavior |
| --- | --- |
| Desktop local | Rust supervises a Python thread-mode sidecar and exposes a narrow command/session bridge to the SDK. |
| Remote console | Async nonsecret profile selects a runtime-configured HTTP/HTTPS Gateway or WebRTC home peer; live SDK session/pairing state supplies authentication and no local sidecar starts. |
| Mesh node | Shared WebView runtime joins WebRTC membership, advertises only approved local capability packs, and may still select a home node for full Python-backed service/admin work. |
| Profiled local bundles | Sidecar profile selects desktop-local-minimal/local CPU/GPU/full dependency sets. |

First-run client setup is invite-first on every shared WebView surface. It
asks only for the local node name, runtime role, and a QR/file/deep-link/pasted
mesh invite; the invite supplies signaling and pairing material. Connection
mode, profile name, Gateway/signaling endpoints, local capability packs, and
stable peer metadata remain editable from the normal connection settings after
the shell is unlocked. The full-screen gate owns an explicit touch-scroll
viewport rather than changing the fixed-shell document overflow contract.

Default bundles are unsigned and use the lean `desktop-local-minimal` sidecar profile. Python-free packages use the neutral `*:client` bundle commands; legacy `*:thin` commands delegate to them for compatibility. See [`TAURI_DESKTOP_BUILD.md`](TAURI_DESKTOP_BUILD.md), [`UI_CLIENT_SURFACE_STATUS.md`](UI_CLIENT_SURFACE_STATUS.md), and `apps/aurora-tauri/README.md`.

## Platform capability truth matrix

UI copy and controls must report capabilities from SDK/native evidence, not from the presence of a route or shell alone.

| Platform mode | Supported evidence path | Native/local claims allowed | Required limit copy |
| --- | --- | --- | --- |
| Hosted web client | `createBrowserWebThinRuntime()` selected by the runtime onboarding profile: HTTP-only, WebRTC-only, or WebRTC-preferred, with remote-console or mesh-node role state. | Gateway-backed state in HTTP mode; direct/configured-STUN/forced-TURN WebRTC DataChannel RPC/events live-proven in Chromium, Firefox, and Playwright WebKit; hosted Chromium invite/SAS/approval/route/navigation/blur/reload UI flow live-proven against the full Python service; browser-supported permissions; AES-GCM/IndexedDB reconnect and room vault with validated nonsecret profile/stable-ID metadata and memory-only fallback. | No Tauri sidecar, keychain, Android role, or iOS App Intent claims; the origin-scoped WebCrypto key does not resist active same-origin XSS or full browser-profile compromise; actual OS page suspension, packaged-WebView, and production-scale certification remain open. |
| Desktop local | `pnpm --filter @aurora/tauri-ui tauri dev` or packaged local build starts/probes the Rust-supervised Python sidecar and loopback Gateway. | Local sidecar status, secure storage, Gateway health, and native desktop command evidence. | Dev uses direct Python sidecar defaults; packaged builds stage profiled sidecar executables separately. |
| Desktop client | Tauri shell asynchronously loads/saves a nonsecret HTTP/WebRTC runtime profile and rebuilds the shared WebView runtime on profile selection. | Remote-console and mesh-node profile persistence, Tauri shell capability evidence, remote Gateway/peer data, OS-keychain peer credential status/proofs without raw token reads, room-secret retrieval scoped to runtime WebRTC reconnect, Python-free AppImage/deb artifact proof, packaged Linux native-fallback live E2E, and native assistant-provider status/catalog composition without JavaScript credential exposure. | No local Python sidecar readiness claim unless the desktop-local package is selected. Packaged macOS/Windows WebView network evidence remains platform-runner evidence. |
| Linux CI | Vitest/Playwright route gates, `tauri:smoke:linux`, `cargo check`, `dev:smoke` under Xvfb, desktop-client live E2E, Android source/build/artifact gates, and iOS policy/frontend/overlay gates. | Linux desktop smoke, packaged Linux desktop client live evidence, Android artifact evidence, and iOS Linux-safe source/config evidence. | Linux cannot run iOS simulator/WKWebView/Swift runtime gates and does not replace Android emulator/device runtime evidence. |
| Android | Tauri generated Android project, runtime-configurable HTTP/HTTPS/WS/WSS client wrappers, Android native plugin payloads, Android preflight reports, Android client bundle checks, x86_64 debug APK proof, and universal four-ABI debug AAB proof. | Assistant role, fallback entrypoints, Android Keystore peer credentials/proofs, biometric/admin-unlock, foreground WebView microphone policy, lifecycle states only from native manifest payloads, Python-free artifact contents, and endpoint-agnostic package policy. | Local emulator/device runtime E2E is blocked in this workspace because adb and Mobile MCP have no device, the x86_64 AVD cannot use `/dev/kvm`, ARM64 software emulation is unsupported on x86_64 QEMU2, and no Waydroid/binder route is available. Release readiness still requires signing inputs, signed AAB/Play evidence, and usable KVM access or an authorized physical device for runtime proof. |
| iOS | Shared iOS WebView client routing, runtime-configurable overlay generation, device-only Keychain reconnect proof and room-secret storage, nonsecret profile source checks on any platform, Linux-safe frontend/policy/overlay checks, and Tauri iOS build/runtime plus MobileSafari and packaged-Tauri-WKWebView Python-peer gates on macOS/Xcode. | Foreground client source capability plus Keychain/profile/proof evidence; Linux-safe `ios:policy`, `build:frontend:ios-client`, and `ios:prepare:client`; Siri/Shortcuts/App Intents, share/deep-link/widget/file-association evidence only after native targets exist and pass runtime smoke. | Linux cannot build or run iOS. Passing simulator, MobileSafari, packaged WKWebView, Swift runtime, signing, and App Store evidence requires macOS/Xcode plus simulator/runtime/toolchain prerequisites; physical-device direct/STUN/TURN evidence remains separate. Aurora must not claim default iOS system-assistant ownership. |

## Tauri security posture

The Tauri shell grants only Aurora-owned command/capability surfaces needed by the SDK. Broad shell, filesystem, process-spawn, notification, dialog, clipboard, and updater capabilities remain denied unless explicitly documented and tested.

See `apps/aurora-tauri/SECURITY.md`.

## PyQt fallback status

PyQt remains useful for local/reference behavior and older workflows. New production UI work should not extend PyQt as the primary UX architecture. When PyQt behavior is still the only implementation of a workflow, document it as a fallback/partial state in [`FEATURE_MATRIX.md`](FEATURE_MATRIX.md) and add SDK/Tauri tests before claiming parity.

`docs/UI_INTEGRATION.md` is retained as the PyQt UIBridge reference. Historical migration notes were moved to `docs/archive/UIBRIDGE_TAURI_MIGRATION.md`.

## Required docs updates for UI changes

When changing frontend behavior, update the narrowest relevant set:

- SDK contract/transport changes: `packages/aurora-sdk/README.md`, [`API_AND_CONTRACTS.md`](API_AND_CONTRACTS.md), and SDK tests.
- Shared UI behavior: `packages/aurora-ui/README.md`, [`PRODUCTION_UI_CONTRACTS.md`](PRODUCTION_UI_CONTRACTS.md), and UI tests.
- Tauri command/security/sidecar behavior: `apps/aurora-tauri/README.md`, `apps/aurora-tauri/SECURITY.md`, [`TAURI_DESKTOP_BUILD.md`](TAURI_DESKTOP_BUILD.md), and Tauri tests.
- User-facing architecture changes: this document and [`FEATURE_MATRIX.md`](FEATURE_MATRIX.md).
- Client profile, target capability, or readiness changes: [`UI_CLIENT_SURFACE_ROADMAP.md`](UI_CLIENT_SURFACE_ROADMAP.md) and [`UI_CLIENT_SURFACE_STATUS.md`](UI_CLIENT_SURFACE_STATUS.md).

## Validation commands

```bash
pnpm --filter @aurora/client test
pnpm --filter @aurora/client test:resilience
pnpm --filter @aurora/ui test
pnpm --filter @aurora/ui test:accessibility
pnpm --filter @aurora/tauri-ui test
pnpm --filter @aurora/tauri-ui typecheck
pnpm --filter @aurora/tauri-ui tauri:smoke:linux
pnpm --filter @aurora/tauri-ui ios:policy
pnpm test:webrtc:interop
pnpm test:webrtc:turn
pnpm test:webrtc:browsers
```

Run `pnpm --filter @aurora/tauri-ui dev:smoke` in a GUI-capable environment when validating the desktop-local sidecar/WebView path. Run `pnpm --filter @aurora/tauri-ui verify:bundle:desktop-client`, `pnpm test:desktop-client:live`, `android:verify:client:apk`, and `android:verify:client:aab` when validating Python-free client artifacts. Run iOS simulator/runtime/signing commands only on macOS with Xcode; Linux can run `ios:policy`, `build:frontend:ios-client`, and `ios:prepare:client`.

- Assistant streaming requests pass `clientTtsPlayback` through the SDK to keep desktop-local server playback distinct from web, desktop client, and mobile client playback.

### Tooling source-first management console

Aurora's `/tools` UI is the operator-facing control center for tool catalog policy. It is source-first rather than tool-card-first: core tools, MCP servers, plugins, mesh peers, unknown/quarantined sources, and blocked sources are grouped in a source rail, and individual tools expand only after a source is selected. The page consumes the Aurora SDK only; it does not call Python services directly.

Backend authority stays in Tooling/Auth/Config contracts:

- `Tooling.GetPolicySummary` reports global policy mode, default approval behavior, counts, and redaction state.
- `Tooling.ListToolSources` and `Tooling.GetToolSourceDetail` expose grouped source rows, selected-source tools, grants, policy rules, pending approvals, and mesh cache metadata.
- `Tooling.SetPolicyMode`, `Tooling.UpsertSourcePolicy`, and `Tooling.UpsertToolPolicyOverride` are manage methods guarded by `Tooling.manage`; dangerous unrestricted mode requires the confirmation text `ALLOW NON-BLOCKED TOOLS`.
- `Tooling.ListPendingApprovals` and `Tooling.ListPolicyAuditEvents` provide redacted management queues/history. Assistant inline approval remains separate: it resumes one exact paused tool call in the assistant thread, while `/tools` manages durable policy/grants.
- `Tooling.TestMCPSource`, `Tooling.CreateMCPSource`, `Tooling.TestPluginSource`, and `Tooling.CreatePluginSource` provide UI-safe onboarding contracts. Until a concrete backend installer/connector is available, these contracts return explicit unsupported results with secrets redacted.

Mesh tool catalogs shown here come from negotiated/cached Tooling announcements. The UI must not fan out to peers during prompt or page render; it displays epoch/hash/stale/unshared/removed state from the local Tooling cache. Newly announced child tools require review unless the operator explicitly enabled future-tool trust.

Surface behavior is resolved through `getAuroraSurfaceProfile`, while runtime role is stored in the runtime profile: desktop-local may show local sidecar affordances, remote-console clients show Gateway/home-peer controls only, mesh-node clients show local capability packs only after real capability and grant evidence, and Android/iOS/mobile must not claim a Python sidecar. Demo/mock data must be labeled as fixture/demo.
