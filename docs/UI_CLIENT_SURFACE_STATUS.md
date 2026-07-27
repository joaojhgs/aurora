# Aurora UI client-surface status

**Status:** Current bounded check

**Snapshot date:** 2026-07-27

**Audience:** contributors deciding what Aurora UI can claim today

This document records the current repository and local artifact evidence behind the client-surface roadmap. It is a bounded source/build/harness snapshot, not a signed-release, live production deployment, app-store approval, or physical-device certification. Refresh this page when implementation or reports change.

For target clients and sequencing, read [`UI_CLIENT_SURFACE_ROADMAP.md`](UI_CLIENT_SURFACE_ROADMAP.md). For the live interop harness, read [`WEBRTC_LIVE_INTEROP_HARNESS.md`](WEBRTC_LIVE_INTEROP_HARNESS.md). For the WebView protocol contract, read [`WEBVIEW_WEBRTC_PROTOCOL_CONTRACT.md`](WEBVIEW_WEBRTC_PROTOCOL_CONTRACT.md).

## Executive state

- The shared TypeScript/WebView runtime is implemented for hosted web thin, desktop Tauri thin, Android thin, and the iOS thin source path. It supports `http-only`, `webrtc-only`, and `webrtc-preferred` connection modes. Packaged `webrtc-only` desktop/Android/iOS shells accept a single exact `wss://` signaling origin, compile no HTTPS Gateway origin into the frontend or CSP, and therefore do not require an Aurora HTTP application server.
- Live browser-to-Python Gateway WebRTC interop passes with the Python HTTP API disabled. Direct, configured-STUN, and forced-TURN foreground sessions pass in Chromium, Firefox, and Playwright WebKit. Every lane is backed by the browser `RTCPeerConnection.getStats()` selected candidate pair. Signaling is MQTT only; application RPC/events use the `aurora-rpc` `RTCDataChannel`.
- The proven live lanes cover deterministic offer/answer roles in both directions, manifest exchange, structured error parity, bidirectionally fragmented 512 KiB RPC, stream completion and Python-observed cancellation, bilateral SAS pairing, reconnect proof without re-entering SAS, revocation fail-closed, scoped event/correlation isolation, redacted secret scanning, and an uncertain-loss mutation window: `G009Interop.Mutate` starts, `G009Interop.MutationStarted` is observed, the browser disconnects before the response settles, and Python records `execution_count=1`. The reports are under `reports/webrtc-interop/{direct,firefox-direct,webkit-direct,stun,firefox-stun,webkit-stun,turn,firefox-turn,webkit-turn}/report.json`.
- Recoverable WebRTC epoch changes reject pending calls, subscription acknowledgements, manifest requests, and streams as transport loss; they do not silently clear timeouts or replay in-flight calls. Native reconnect storage reports “not found” separately from backend failure: only the former may proceed to SAS pairing, while backend failure produces a typed redacted diagnostic and fails closed.
- Desktop thin AppImage/deb artifact proof and Android thin debug APK/AAB artifact proof pass. Thin bundles contain no Python executable, Python runtime assets, `config_defaults.json`, `site-packages`, or sidecar resources. Desktop-local remains a separate Rust-supervised Python sidecar path.
- Android foreground WebView microphone policy, lifecycle release policy, and Keystore-backed peer credential/proof commands are implemented and build-proven. Python, TypeScript, Rust, Kotlin, and Swift use the same canonical `mesh_auth_proof_v1` HMAC transcript, including Python-compatible ASCII escaping for Unicode peer/room values. The packaged thin APK now passes API 30 System WebView UI/native-payload E2E locally, including responsive bottom navigation and redacted native metadata. Do not claim durable Android background wakeword.
- Playwright Chromium, Firefox, and WebKit are installed in the current verification environment and all three direct/STUN/TURN report sets pass. The existing API 35 Android workflow now runs the same protocol assertions twice against an external Python peer: once in the packaged System WebView and once in standalone Android Chrome without CDP. Both required emulator lanes force TURN while local diagnostic runs may select direct or STUN explicitly. One bounded Android aggregate passes only when the combined command and both complete, redacted, HTTP-disabled scanner reports pass. The existing macOS iOS workflow now runs the same direct-path assertions twice on an iPhone simulator: once in MobileSafari and once in a dedicated packaged Tauri WKWebView app that is scanned for forbidden Python/sidecar paths. Fresh passing evidence from the new mobile gates remains pending. Page suspension, physical/OEM paths, and production browser certification remain unclaimed.
- Ordered DataChannel delivery is preserved through asynchronous frame decryption. A regression test delays the first encrypted frame and proves a pairing reveal cannot overtake its preceding commitment; the previously flaky Firefox TURN lane then passed three consecutive runs before the full cross-engine matrix passed.
- Android CI now installs compile SDK 36 (while retaining the API 35 emulator image) and all four Android Rust targets required by the universal AAB. This closes the clean-run mismatch between the generated `compileSdk = 36` project and the prior SDK/target setup.
- iOS thin source wiring is implemented: the Tauri runtime selects the shared WebView HTTP/WebRTC path, the Rust commands route to Swift, peer reconnect bearer material is held in device-only/non-synchronizing Keychain items behind status/delete/proof commands, and nonsecret profiles use `UserDefaults`. The supported simulator build wrapper generates a temporary least-privilege Python-free overlay from exact operator HTTPS/WSS origins, rejects insecure/broad origins, and records successful-build provenance. This environment cannot produce Xcode artifacts, so iOS remains build/live-limited until macOS simulator/device direct-STUN-TURN, microphone/lifecycle, signing, and App Store/TestFlight evidence passes.
- Python-in-Rust compilation or embedding was rejected/deferred. Thin shells do not need Python; desktop-local keeps Python as a separate supervised sidecar process.
- Hosted web thin now persists the reconnect bearer and room secret only as AES-GCM ciphertext in IndexedDB, persists a validated nonsecret connection profile and stable browser peer ID in `localStorage`, scrubs the invite fragment, and automatically re-dials the saved profile after a refresh. If IndexedDB, WebCrypto, key structured-cloning, or metadata storage fails, the runtime reports the downgrade and remains memory-only; it never writes plaintext secrets as a fallback.
- Reversible WebRTC rollout gates are implemented across hosted web and Tauri/WebView shells. Disabling the main thin-client gate sends only `webrtc-preferred` profiles with an explicit Gateway to HTTP, keeps `webrtc-only` fail-closed, leaves desktop-local intact, and neither loads nor rewrites saved peer credentials. Scoped-subscription and fragmentation/backpressure gates alter the local capability hello, so the Python and TypeScript peers use the same negotiated intersection. An E2EE-required profile fails closed when its local E2EE gate is disabled. The Gateway legacy non-sensitive broadcast compatibility path is separately configurable and hot-reloadable; sensitive/scoped-only topics remain blocked.

## Current client readiness

Legend: **Implemented** means a usable code path exists within the stated boundary; **Build-proven** means artifact/package checks ran successfully; **Live-proven** means a live interop or runtime harness passed; **Planned/limited** means important platform proof or implementation is still missing.

| Client profile | Current state | Evidence and boundary | Main gaps before broader support claim |
| --- | --- | --- | --- |
| Hosted web thin over HTTP | **Implemented, bounded** | `apps/aurora-web/app/aurora-client.ts` selects HTTP transport by default and accepts `NEXT_PUBLIC_AURORA_CONNECTION_MODE=http-only`. | Deployment-specific TLS/CORS/auth and operator endpoint rollout remain environment-specific. |
| Hosted web thin over WebRTC | **Implemented, cross-engine direct/STUN/TURN live-proven** | `createBrowserWebThinRuntime()` and `createBrowserWebRtcAuroraRuntime()` support `webrtc-only`/`webrtc-preferred`; Chromium/Firefox/Playwright-WebKit direct, configured-STUN, and forced-TURN reports passed with the HTTP API disabled. The hosted shell uses an encrypted IndexedDB credential/room vault, validated nonsecret profile metadata, a stable browser peer identity, and refresh re-dial. | Desktop packaged-WebView network proof, pending Android/iOS native-WebView CI results, production signaling/TURN scale, long-running reconnect/load, page suspension, hosted deployment evidence, and WebAuthn-bound vault unlock remain unproven. |
| Desktop Tauri local + Python sidecar | **Implemented, bounded** | Tauri local mode supervises an external Python thread-mode sidecar, probes loopback Gateway, and writes `apps/aurora-tauri/reports/tauri-dev-smoke.json`. | Signed/notarized release artifacts and full profile/hardware matrices remain release-specific. |
| Desktop Tauri thin over HTTP/WebRTC | **Implemented, build-proven** | Async nonsecret profile load/edit/save/select reconstructs the shared WebView runtime for `http-only`, `webrtc-only`, or `webrtc-preferred`. Exact HTTPS Gateway and WSS signaling origins are CSP-allowlisted by mode. A fresh WSS-only AppImage/deb build had `gatewayOrigin=null`, only the signaling WSS origin in `connect-src`, and passed `verify:bundle:desktop-thin` with no forbidden Python/sidecar matches. | New production remote origins require rebuilding/signing the package; live desktop WebView-specific WebRTC smoke beyond the shared browser-engine harness remains environment-specific. |
| Android thin over HTTP/WebRTC | **Implemented, build- and UI-runtime-proven; WebRTC CI gates pending** | Android thin overlay, native plugin sync, Keystore peer credential/proof commands, WebView microphone policy, lifecycle status, x86_64 debug APK proof, and universal debug AAB proof exist. Fresh APK/AAB builds used WSS-only `webrtc-only` configuration with `gatewayOrigin=null`; artifact proof passed. The packaged APK also passes API 30 UI/native-payload E2E. API 35 CI now runs both packaged-System-WebView and standalone-Android-Chrome forced-TURN pairing/RPC/reconnect/revocation against an external Python peer; local diagnostics retain explicit direct/STUN/TURN selection. | Fresh passing API 35 WebRTC evidence remains pending. Release signing, Play/App Distribution, OEM microphone/lifecycle behavior, physical STUN/TURN device paths, and durable background voice remain unproven. |
| Android native-enhanced | **Partial/limited** | Native plugin reports assistant role, fallback entrypoints, notifications, biometric/admin unlock, foreground service readiness, and media policy evidence. | Foreground service evidence is permission/lifecycle readiness, not a completed durable wakeword/audio/model pipeline. Durable background wakeword is not claimed. |
| iOS thin over HTTP/WebRTC | **Implemented in source; build/live-limited** | `apps/aurora-tauri/src/aurora-client.ts` routes iOS through the shared WebView thin runtime and native opaque credential store. Rust routes the six thin profile/credential commands to Swift. `AuroraThinPeerStorage.swift` uses hashed peer accounts, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, no Keychain sync/raw getter, canonical HMAC reconnect proof, and nonsecret `UserDefaults` profiles. `ios:prepare:thin` and the simulator wrapper generate a temporary exact-origin `aurora-ios-thin` overlay with no external binaries/resources; WSS-only `webrtc-only` generation passes with no Gateway origin. `tauri-ios.yml` builds, installs, launches, screenshots, log-checks, and terminates the thin app in a real iOS simulator, then runs the shared external-Python direct-path contract in both MobileSafari and a dedicated packaged Tauri WKWebView simulator app. | Fresh passing evidence from the macOS gates remains pending. Passing MobileSafari and packaged-WKWebView reports, microphone/lifecycle behavior, physical-device direct/STUN/TURN smoke, signing, and TestFlight evidence remain pending. |
| iOS native-enhanced | **Planned/limited** | Policy copy forbids default system-assistant claims and allows only Siri/Shortcuts/App Intents integration. | App Intents/share/widget targets must be wired and smoked on macOS/Xcode; durable background voice and raw audio are unsupported without explicit Apple-permitted evidence. |
| PyQt local fallback | **Maintained fallback** | Python UIBridge remains as legacy local/reference behavior. | Not the target for new multi-platform UI or WebView WebRTC behavior. |

## Implemented shared WebView runtime

`packages/aurora-ui/src/web-thin-runtime.ts` wraps `@aurora/client/webrtc` and constructs one surface-aware runtime for hosted web, desktop Tauri thin, Android thin, and iOS thin. It exposes the same user-facing modes everywhere:

| Mode | Behavior |
| --- | --- |
| `http-only` | Uses HTTP Gateway transport and does not touch `RTCPeerConnection`, MQTT signaling, or peer credentials. |
| `webrtc-only` | Requires a WebRTC invite/profile and exact secure signaling origin, fails closed when no authorized peer is connected, and does not need or fall back to an Aurora HTTP Gateway. |
| `webrtc-preferred` | Uses WebRTC for authorized peer routes and allows HTTP only as an explicit fallback for new calls when a Gateway endpoint exists. It does not blindly replay uncertain mutations after transport loss. |

Runtime and UI evidence:

- `packages/aurora-sdk/src/webrtc/` implements browser/WebRTC crypto, MQTT signaling, peer sessions, RPC protocol parsing, flow control/backpressure, fragmentation, scoped subscriptions, manifests, pairing, reconnect proof, and `WebRtcMeshPeerBridge`.
- `packages/aurora-ui/src/web-thin-runtime.ts`, `packages/aurora-ui/src/browser-peer-persistence.ts`, and `packages/aurora-ui/src/web-thin-connection-panel.tsx` expose invite import, secure-context checks, persistence/fallback diagnostics, encrypted browser secrets, and validated profile metadata.
- `apps/aurora-web/app/aurora-client.ts` selects `http-only`, `webrtc-only`, or `webrtc-preferred` from `NEXT_PUBLIC_AURORA_CONNECTION_MODE`, restores the stable peer/profile, automatically re-dials after refresh, and keeps server-side demo fallback explicitly labeled.
- `apps/aurora-tauri/src/aurora-client.ts` and `apps/aurora-tauri/src/tauri-app.tsx` use the same runtime for desktop/mobile thin profiles while keeping desktop-local sidecar behavior separate.

Rollout inputs default to enabled for backward compatibility:

| Gate | Hosted web | Tauri/WebView | Verified rollback behavior |
| --- | --- | --- | --- |
| Thin-client entry point | `NEXT_PUBLIC_AURORA_WEBRTC_THIN_CLIENT` | `VITE_AURORA_WEBRTC_THIN_CLIENT` | `webrtc-preferred` uses configured HTTP; `webrtc-only` fails closed; stored peer credentials are not consumed, deleted, or migrated. |
| Scoped subscriptions | `NEXT_PUBLIC_AURORA_WEBRTC_SCOPED_SUBSCRIPTIONS` | `VITE_AURORA_WEBRTC_SCOPED_SUBSCRIPTIONS` | Removes `scoped_event_subscriptions_v1` from the local hello; both peers use the negotiated intersection. |
| Fragmentation/backpressure | `NEXT_PUBLIC_AURORA_WEBRTC_FRAGMENTATION` | `VITE_AURORA_WEBRTC_FRAGMENTATION` | Removes `fragmentation_v1` and `backpressure_v1`; oversized frames fail instead of using an unnegotiated extension. |
| Application E2EE allowance | `NEXT_PUBLIC_AURORA_WEBRTC_APP_LAYER_E2EE` | `VITE_AURORA_WEBRTC_APP_LAYER_E2EE` | A profile explicitly allowing DTLS-only JSON can run plaintext; a profile requiring app-layer E2EE fails closed. |

The Python compatibility gate is
`services.gateway.webrtc.legacy_event_broadcast`. It affects only the temporary
non-sensitive unscoped broadcast path and can be updated through normal
Gateway config reload.

## Live WebRTC interoperability evidence

Required lanes pass through `scripts/webrtc_interop*.{sh,mjs,py}` and write `reports/webrtc-interop/<lane>/report.json`.
The WebRTC CI workflow runs the full browser/lane matrix with
`WEBRTC_INTEROP_REQUIRE_ALL_BROWSERS=1`, so unavailable Chromium, Firefox, or
WebKit runtimes fail the required lane rather than producing an accepted skip.

| Lane | Report | ICE path | Status | Key proof |
| --- | --- | --- | --- | --- |
| Chromium direct | `reports/webrtc-interop/direct/report.json` | `prflx` | Passed | The selected peer-reflexive/host pair has no gathered STUN or relay evidence; registry read and events use `RTCDataChannel`; Gateway HTTP API is disabled/unreachable; no browser HTTP fetch transport calls. |
| Chromium STUN | `reports/webrtc-interop/stun/report.json` | `srflx` | Passed | The selected reflexive pair and configured-STUN candidate URL match come from `getStats()`. The same auth/event/mutation/revocation checks passed. |
| TURN | `reports/webrtc-interop/turn/report.json` | `relay` | Passed | `selectedCandidatePair.category=relay` from browser `RTCPeerConnection.getStats()`; relay-only policy forced TURN; same auth/event/mutation/revocation checks passed. |
| Firefox direct | `reports/webrtc-interop/firefox-direct/report.json` | `host` | Passed | Firefox completed the same HTTP-disabled DataChannel, auth, reconnect, mutation, scope, and redaction assertions. |
| Firefox STUN | `reports/webrtc-interop/firefox-stun/report.json` | `prflx` selected, configured `srflx` gathered | Passed | Firefox omitted the candidate URL from stats; exactly one configured STUN server makes the gathered source unambiguous, and the report records that evidence mode instead of fabricating a URL match. |
| Firefox TURN | `reports/webrtc-interop/firefox-turn/report.json` | `relay` | Passed | Firefox completed the same assertions under relay-only policy with a selected relay pair. |
| WebKit direct | `reports/webrtc-interop/webkit-direct/report.json` | `prflx` | Passed | WebKit completed the same assertions. The scanner accepted the peer-reflexive/host pair only because the direct lane had no gathered STUN or relay evidence, and it did not rewrite the raw category. |
| WebKit STUN | `reports/webrtc-interop/webkit-stun/report.json` | `srflx` | Passed | Playwright WebKit completed the same assertions with a selected configured-STUN reflexive pair from `getStats()`. |
| WebKit TURN | `reports/webrtc-interop/webkit-turn/report.json` | `relay` | Passed | Playwright WebKit completed the same assertions with a selected relay pair from `getStats()`. |
| Android System WebView TURN | `apps/aurora-tauri/reports/webrtc-interop/android-webview/report.json` | `relay` required | CI gate added; fresh passing evidence pending | `android-python-webrtc.e2e.test.ts` drives the packaged API 35 WebView over CDP, pairs with the same external Python peer, and requires the same DataChannel, reconnect, mutation, revocation, redaction, and no-HTTP-fallback evidence. |
| Android Chrome TURN relay | `apps/aurora-tauri/reports/webrtc-interop/android-mobile-browser/report.json` | relay required in CI | CI gate added; fresh run pending | `android-browser-python-webrtc.e2e.test.ts` launches standalone Android Chrome without CDP, auto-runs the shared browser harness, posts the result only after runtime close, and requires the same external-Python, DataChannel, reconnect, mutation, revocation, redaction, and no-HTTP-fallback evidence. CI forces TURN because emulator direct ICE host reachability is not stable enough for a required PR gate. |
| iOS MobileSafari simulator direct | `apps/aurora-tauri/reports/webrtc-interop/ios-mobile-safari/report.json` | direct required | CI gate added; fresh run pending | `ios-python-webrtc.e2e.test.ts` boots an iPhone simulator, launches MobileSafari without CDP/Web Inspector, starts a local WebSocket MQTT broker plus external Python peer, and requires the complete shared interop and redaction contract. |
| iOS packaged Tauri WKWebView simulator direct | `apps/aurora-tauri/reports/webrtc-interop/ios-wkwebview/report.json` | direct required | CI gate added; fresh run pending | The same serial E2E builds and scans a dedicated unsigned Tauri WKWebView app, installs/launches it with `simctl`, and requires the same external-Python bilateral-pairing, DataChannel, reconnect, mutation, revocation, HTTP-disabled, and redaction evidence. |

The passing reports assert:

- `gatewayApiEnabled=false`, `gatewayHttpReachable=false`, and `noHttpFetchTransportUsed=true`;
- `registryReadOverDataChannel=true`, `eventOverDataChannel=true`, and `ttsEventOverDataChannel=true`;
- `reconnectWithoutSas=true` and `authorizedWithoutSas=true` after canonical reconnect proof;
- `revokedCredentialFailsClosed=true` and `routeAuthorizedAfterRevocation=false`;
- `mutationAtMostOnce=true`, `mutationUncertainLossWindow=true`, `execution_count=1`, `startedAckBeforeDisconnect=true`, `responseSettledBeforeDisconnect=false`, and `disconnectBeforeResponseSettled=true`;
- `wildcardDelivered=false`, `wrongCorrelationDelivered=false`, and matching Python-side subscription isolation;
- `redaction.passed=true`, `secretsRedacted=true`, and no findings in the scanned lane reports.

## Packaging and platform evidence

| Artifact/profile | Command verified locally | Report | Current result |
| --- | --- | --- | --- |
| Desktop thin AppImage/deb | `AURORA_TAURI_ALLOWED_REMOTE_ORIGINS="wss://signaling.example.invalid" AURORA_TAURI_THIN_CONNECTION_MODE=webrtc-only pnpm --filter @aurora/tauri-ui build:bundle:desktop-thin` | `apps/aurora-tauri/reports/desktop-thin-bundle-{prepare,proof}.json` | Passed; the generated policy had `gatewayOrigin=null` and only WSS signaling in `connect-src`; artifact proof checked 247 files and 2 archives with no forbidden Python/sidecar matches, no external binaries/resources, and `aurora-thin` capability. |
| Android thin debug APK | `AURORA_TAURI_ANDROID_ALLOWED_REMOTE_ORIGINS="wss://signaling.example.invalid" AURORA_TAURI_THIN_CONNECTION_MODE=webrtc-only pnpm --filter @aurora/tauri-ui android:build:thin:apk` then `android:verify:thin:apk` | `apps/aurora-tauri/reports/android-thin-apk-{build-provenance,artifact-proof}.json` | Passed; provenance records `gatewayOrigin=null` and WSS-only `connect-src`; artifact proof checked the generated x86_64 debug APK archive (under Gradle's `universal` output flavor) with no forbidden Python/sidecar matches and `aurora-android-thin` capability. |
| Android thin debug AAB | `AURORA_TAURI_ANDROID_ALLOWED_REMOTE_ORIGINS="wss://signaling.example.invalid" AURORA_TAURI_THIN_CONNECTION_MODE=webrtc-only pnpm --filter @aurora/tauri-ui android:build:thin:aab` then `android:verify:thin:aab` | `apps/aurora-tauri/reports/android-thin-aab-{build-provenance,artifact-proof}.json` | Passed; provenance records `gatewayOrigin=null` and WSS-only `connect-src`; artifact proof checked the generated universal debug AAB archive with no forbidden Python/sidecar matches and `aurora-android-thin` capability. |
| Android preflight | `pnpm --filter @aurora/tauri-ui android:preflight:ci` / `android:preflight` | `apps/aurora-tauri/reports/android-preflight.json` | Generated project and native plugin parity passed; signing inputs are not configured in local non-strict preflight. |
| Android API 30 packaged UI/native payload | `pnpm --filter @aurora/tauri-ui android:smoke` | Vitest/CDP output; screenshots may be captured through Mobile MCP | Passed locally on the real thin APK/System WebView. The test rejects Tauri/console errors, validates safe redacted native payload fields, waits for runtime stability, and proves the responsive mobile bottom navigation remains above Android system navigation. |
| Android API 35 packaged WebView ↔ Python peer | `pnpm --filter @aurora/tauri-ui android:webrtc:interop` | `apps/aurora-tauri/reports/webrtc-interop/android-webview/` | Implemented in the existing Android workflow; fresh KVM-backed CI result pending. Python is an external protocol peer only, and APK/AAB artifact proof remains Python-free. |
| Android API 35 standalone browser ↔ Python peer | `pnpm --filter @aurora/tauri-ui android:webrtc:mobile-browser` | `apps/aurora-tauri/reports/webrtc-interop/android-mobile-browser/` | Implemented without CDP and included in the same Android workflow/check as the packaged WebView test; fresh KVM-backed CI result pending. |
| iOS simulator MobileSafari ↔ Python peer | `pnpm --filter @aurora/tauri-ui ios:webrtc:interop` | `apps/aurora-tauri/reports/webrtc-interop/ios-mobile-safari/` | Implemented in the existing macOS iOS workflow with the shared browser assertions and scanner; fresh CI result pending. |
| iOS simulator packaged WKWebView ↔ Python peer | `pnpm --filter @aurora/tauri-ui ios:webrtc:interop` | `apps/aurora-tauri/reports/webrtc-interop/ios-wkwebview/` | Implemented in the same existing macOS job/check. The temporary Tauri test app declares no external binaries/resources and the built `.app` is scanned for forbidden Python/sidecar paths. Python and Mosquitto remain external test-only processes. |
| iOS thin generated overlay | `AURORA_TAURI_IOS_ALLOWED_REMOTE_ORIGINS="wss://signaling.example.invalid" AURORA_TAURI_THIN_CONNECTION_MODE=webrtc-only pnpm --filter @aurora/tauri-ui ios:prepare:thin` | `apps/aurora-tauri/reports/ios-thin-bundle-prepare.json` | Passed; generated a WSS-only CSP with `gatewayOrigin=null`, selected `aurora-ios-thin`/`aurora-mobile-mesh`, and declared no external binaries or resources. This is source/config proof, not an Xcode artifact. |
| Desktop local smoke | `pnpm --filter @aurora/tauri-ui dev:smoke` | `apps/aurora-tauri/reports/tauri-dev-smoke.json` | Passed in the recorded report; proves loopback Gateway readiness and `[tauri]`/`[aurora][...]` logs for desktop-local, not thin WebRTC. |

Thin package proof is an artifact-content claim only. The Android emulator tests add runtime evidence but still do not prove remote production endpoints, signing/notarization, store submission, physical/OEM behavior, or desktop/iOS WebView-specific network behavior.

## Fresh verification snapshot

The following checks completed in the local 2026-07-27 verification environment:

| Gate | Result |
| --- | --- |
| Playwright installation | Playwright `1.61.1`; Chromium, Firefox, and WebKit executables installed. |
| Python quality/config | `make check` and `make check-config-generated` passed. |
| Python suite | Fresh `make unit`: **2195 passed, 38 skipped**, 76% coverage. Previous broader `make test` baseline: **2266 passed, 76 skipped**, 77% coverage; all **18** Python E2E tests, including both two-instance mesh modes, passed earlier in this change series. |
| TypeScript suite | Fresh `pnpm -r test`: **778 passed** across SDK (319), shared UI (280), Tauri (162), web (14), and mock (3). The Tauri aggregate runs test files serially so subprocess-heavy package proof tests cannot starve UI route-test timers; Android/iOS/desktop bundle proof files explicitly use the Node test environment. |
| TypeScript static/build | `pnpm -r typecheck` and `pnpm -r build` passed. |
| Rust host checks | `cargo fmt --check`, `cargo clippy --all-targets --all-features -- -D warnings`, and `cargo test --all-targets --all-features` passed; **46 Rust tests passed**. |
| Browser route smoke | Playwright route crawl: **4 passed**. |
| Browser encrypted persistence | Real reload/restoration passed in Chromium, Firefox, and WebKit: **3 passed** with no plaintext reconnect/room secrets in browser storage. |
| Live WebRTC | All **9** Chromium/Firefox/WebKit direct/STUN/TURN lanes passed with the Gateway HTTP API disabled and report redaction enabled. |
| Desktop thin package | Fresh AppImage/deb build and `desktop-thin-bundle-proof.json` passed. |
| Android thin packages | The final WSS-only x86_64 debug APK was rebuilt after the WebView compatibility fixes and its artifact proof passed with `gatewayOrigin=null` and zero forbidden Python/sidecar matches. The universal debug AAB and proof also passed earlier in this change series. |
| Android emulator/Mobile MCP | The API 30 default AOSP packaged UI/native-payload test passed. Mobile MCP connected to the current API 35 Google-APIs emulator and inspected Android Chrome during the new mobile-browser test. |
| Android WebView/browser ↔ Python WebRTC | Both normal Android E2E tests, the shared API 35 KVM CI wiring, and a unit-tested fail-closed combined report are implemented and statically verified. `android:webrtc:interop` deletes stale child reports and writes `reports/webrtc-interop/android-aggregate-report.json`; it cannot pass unless the packaged WebView TURN report, standalone-browser TURN report in CI (or the explicitly selected diagnostic lane locally), shared protocol/behavior assertions, HTTP-disabled proofs, redaction checks, and combined Vitest command all pass. Local runs used the real external Python `RTCClient` with the Aurora HTTP API disabled, but this `-accel off` host could not produce a passing mobile aggregate. On API 35, the packaged WebView renderer terminated the Tauri app and standalone Chrome 124 later terminated its renderer with `SIGTRAP`; an Android 16/Trichrome 133 image also trapped during software-emulated WebView initialization. On the rootable API 30 AOSP image, the packaged WebView 83 reached MQTT signaling but derived signaling keys incompatible with Python under the software emulator; independent `@noble/hashes` 2.2 and 1.8 protocol-vector probes reproduced the mismatch, while forcing V8 `--jitless` did not complete the encrypted peer handshake within 240 seconds. This old frozen WebView/software-emulator result is a diagnostic boundary, not a reason to weaken scrypt parameters or change the interoperable browser/Python protocol. The WebView harness rejects closed CDP sessions and always emits a redacted failed browser/done report when setup or runtime fails. Neither failed report produces a passing aggregate; authoritative Android evidence remains pending a current KVM-backed API 35 run. |
| Android evidence integrity | Bundle/proof unit tests write only to temporary config, provenance, proof, and preflight paths. SHA-256 checks before and after targeted, full Tauri, and full workspace test runs confirmed that the real APK/AAB provenance and artifact-proof reports were unchanged. |
| Android preflight | **15 checks passed**; the one non-required blocked item is absent release-signing configuration in local non-strict mode. |
| iOS thin source/policy | Tauri/SDK tests, `build:frontend:ios-thin`, `ios:prepare:thin`, and `ios:policy` pass for shared iOS WebView routing, Keychain/profile/proof source invariants, exact-origin least-privilege overlay generation, and the macOS simulator CI wrapper/provenance command. This is not Xcode build or runtime proof. |
| iOS MobileSafari/WKWebView ↔ Python WebRTC | One normal serial E2E test, macOS workflow wiring, shared assertion/scanner reuse, separate per-surface reports, packaged-app path scanning, and Linux skip/transform/typecheck gates are implemented. Fresh passing MobileSafari and packaged-Tauri-WKWebView simulator reports remain pending; physical-device direct/STUN/TURN evidence remains separate. |

The local Android build used Temurin 17, Android platforms 35/36, build-tools 35.0.0, NDK 27.0.12077973, and all four Android Rust targets. `mobile-next/mobile-mcp` is installed in Codex and connected successfully to the API 30 and API 35 emulators. Waydroid cannot run in this unprivileged Podman workspace: it has no host binder/ashmem interfaces, no usable systemd/Wayland session, and no permission to `/dev/kvm`. Artifact/build proof and the software-emulator UI smoke are not substitutes for the pending KVM API 35 or physical-device WebRTC result.

## Voice and native capability boundaries

Voice ownership remains surface-aware through `packages/aurora-ui/src/platform-surface.ts`:

- **Desktop local:** durable wakeword/background capture remains Python `STTCoordinator` ownership. Focused WebView push-to-talk/waveform can run while the UI is foregrounded.
- **Hosted web and desktop thin:** focused WebView capture can support push-to-talk/read-aloud. They must not claim durable background listening.
- **Android thin:** WebView microphone permission decisions require trusted HTTPS/`tauri.localhost` origin, Android `RECORD_AUDIO`, foreground, and focus. Lifecycle status sets `backgroundWakeword=false` and `mustReleaseMicrophone=true` when backgrounded/unfocused.
- **iOS:** the foreground thin HTTP/WebRTC source path and native credential/profile bridge are implemented. Focused WebView microphone use remains subject to WKWebView/iOS permission and lifecycle proof; durable background voice remains unsupported. Siri/Shortcuts/App Intents/share/deep-link entrypoints remain app-owned and user-invoked.

Android native evidence currently covers policy/status/proof commands and build artifacts. It does not prove physical-device microphone capture, background service behavior, local model execution, or wakeword/audio pipeline operation.

## Python sidecar and Rust integration verdict

Desktop-local Python remains an **external supervised process**. Rust starts/stops the sidecar, probes loopback Gateway readiness, and exposes narrow command surfaces. Thin shells are Python-free because they use remote HTTP or WebView WebRTC; they do not compile Aurora's Python services into Rust.

Python-in-Rust alternatives were rejected/deferred for the current product split:

| Option | Verdict |
| --- | --- |
| Embed CPython/PyO3 in Rust | Rejected/deferred: still ships Python/runtime/native wheels and weakens the tested process isolation boundary. |
| Convert Aurora services to Cython/Nuitka libraries | Rejected/deferred: high compatibility risk and still Python-runtime coupled for much of the stack. |
| Rewrite Gateway/WebRTC/services in Rust | Deferred: duplicates protocol/auth/mesh/bus behavior and creates a long-term parity burden. |
| Keep external Python sidecar for desktop-local plus Python-free thin shells | Current direction: preserves local capability while letting thin WebView clients run without Python. |

## Rollback and runtime profile modes

Runtime rollback uses explicit profile selection rather than hidden transport mutation:

- Set the surface-specific `*_AURORA_WEBRTC_THIN_CLIENT` build gate to false for an emergency stop of new WebRTC sessions. Preferred profiles with a configured Gateway select HTTP; WebRTC-only profiles report disabled and fail closed.
- Switch hosted web or Tauri thin profile to `http-only` to bypass WebRTC for new calls.
- Use `webrtc-only` only when the operator wants fail-closed direct-peer behavior with no HTTP fallback.
- Use `webrtc-preferred` when both a Gateway endpoint and WebRTC invite/profile exist; fallback applies to new calls only.
- Revoke a peer credential to force the next WebRTC route to fail closed and return to SAS pairing. Every current live lane report proves this behavior.
- Rebuild/redeploy desktop/mobile thin artifacts when allowed HTTPS/WSS origins change; strict CSP is part of the package boundary.
- Keep desktop-local sidecar profiles (`desktop-local-minimal`, `local-cpu`, GPU profiles, `full`) separate from thin profiles. Do not use sidecar preparation as a rollback for web/desktop/mobile thin.
- Do not delete, rewrite, or translate peer or HTTP credentials during rollback. Re-enable uses the same saved material unless it was separately revoked.

## Security limitations still open

- Direct, configured-STUN, and forced-TURN foreground interop is live-proven in Chromium, Firefox, and Playwright WebKit. Android packaged-WebView UI/native behavior is locally proven and its Python-peer WebRTC CI gate is implemented but not yet run. The iOS packaged-WKWebView simulator gate is also implemented but lacks a passing macOS report; desktop packaged-WebView network behavior, background/page-suspension behavior, physical/OEM paths, and production-scale browser certification remain unproven.
- TURN was proven against local coturn, not a production TURN service under load.
- Long-running reconnect, large messages, fragmentation under hostile networks, and production-scale MQTT/TURN observability require further soak/load tests.
- Hosted-web reconnect and room secrets are AES-GCM encrypted before IndexedDB storage; only validated nonsecret profile/stable-ID metadata is written to `localStorage`, and any persistence failure downgrades to memory-only. The non-extractable WebCrypto key currently lives in the same origin-scoped IndexedDB database, so this protects against plaintext inspection/accidental disclosure but **not** a compromised browser profile or active same-origin XSS that can invoke the application and WebCrypto. Desktop/mobile native stores hold only scoped peer reconnect material and must keep raw long-lived secrets out of logs, URLs, profiles, `localStorage`, and `sessionStorage`. Native proof commands must stay vector-compatible with canonical `mesh_auth_proof_v1` HMAC fixtures, including Python `ensure_ascii` behavior for Unicode values, and must not emit legacy `proof_hmac_sha256`.
- Stronger long-term hosted-web design: derive/unseal the vault key through a user-verified WebAuthn PRF/passkey and replace stored bearer reconnect with a server challenge signed by a WebAuthn-bound device key. That removes the reusable bearer from browser storage and makes offline profile theft materially harder; it still requires strict CSP/Trusted Types and dependency hygiene because no in-page vault survives active XSS after unlock.
- Scoped authorization remains on public production boundaries: SAS-bound Auth pairing/connect/exchange and public Gateway/Auth methods over the DataChannel, not private/test-only bypasses or internal service calls. Thin clients should advertise consumer-only/minimal manifests and reject unsolicited inbound service calls unless explicitly configured.
- Remote audio/wakeword sharing remains policy-gated; no raw microphone or durable wakeword stream is release-ready without explicit user consent, selectors, and platform proof.
