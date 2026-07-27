# Aurora Tauri Shell

This package is the official Tauri 2 desktop shell for Aurora. It hosts the production React UI and keeps Aurora service state behind `AuroraClient`.

## Modes

- Desktop local: uses the Tauri IPC bridge to start, monitor, and stop a Rust-supervised Python thread-mode sidecar while UI data still flows through `AuroraClient`.
- Desktop thin: use the packaged connection-profile editor to select HTTP-only, WebRTC-only, or WebRTC-preferred. HTTP-only packages require an exact HTTPS Gateway origin; WebRTC-only packages require an exact WSS signaling origin and compile no Gateway origin; WebRTC-preferred packages require both. The persisted profile contains only nonsecret endpoint and stable peer metadata; authentication stays in the live SDK session and mesh invites stay in the URL fragment/in memory. Native shell probes remain local capability evidence only, and `build:bundle:desktop-thin` packages this mode without Python sidecar files.
- Android/iOS thin: use the same TypeScript WebView HTTP/WebRTC runtime. Android stores peer reconnect material behind Keystore-backed proof commands; iOS uses a device-only, non-synchronizing Keychain item and computes the same canonical reconnect proof without returning the bearer to JavaScript. Both persist only sanitized nonsecret profile documents outside the credential store.
- Browser development fallback: `VITE_AURORA_GATEWAY_URL` also selects HTTP transport in browser previews; in a plain browser preview without Tauri or a reachable loopback Gateway, the SDK mock transport is a **degraded development fixture only**, not live Aurora state.

## Thin endpoint policy

Thin package wrappers accept only exact secure, root origins. Wildcards, credentials, `http:`/`ws:`, paths, query strings, and fragments fail closed. Set `AURORA_TAURI_THIN_CONNECTION_MODE` and the platform origin variable as follows:

| Mode | Required packaged origins | Aurora HTTP application server |
| --- | --- | --- |
| `http-only` | One exact `https://` Gateway origin | Required |
| `webrtc-only` | One exact `wss://` signaling origin | Not required; no Gateway origin is compiled into the frontend or CSP |
| `webrtc-preferred` | Exact `https://` Gateway and `wss://` signaling origins | Required only as the explicit fallback path |

Python-free WSS-only build examples:

```bash
# Desktop AppImage/deb
AURORA_TAURI_ALLOWED_REMOTE_ORIGINS="wss://signaling.example" \
AURORA_TAURI_THIN_CONNECTION_MODE=webrtc-only \
pnpm --filter @aurora/tauri-ui build:bundle:desktop-thin

# Android debug APK (use android:build:thin:aab for the universal AAB)
AURORA_TAURI_ANDROID_ALLOWED_REMOTE_ORIGINS="wss://signaling.example" \
AURORA_TAURI_THIN_CONNECTION_MODE=webrtc-only \
pnpm --filter @aurora/tauri-ui android:build:thin:apk

# iOS simulator, on macOS/Xcode
AURORA_TAURI_IOS_ALLOWED_REMOTE_ORIGINS="wss://signaling.example" \
AURORA_TAURI_THIN_CONNECTION_MODE=webrtc-only \
pnpm --filter @aurora/tauri-ui ios:build:thin:simulator

# iOS simulator MobileSafari + packaged WKWebView ↔ external Python peer, on macOS/Xcode
pnpm --filter @aurora/tauri-ui ios:webrtc:interop
```

These packages still need STUN and usually TURN URLs in the imported peer invite/profile. WSS signaling is rendezvous only; Aurora RPC, streams, cancellation, and events use the WebRTC DataChannel after negotiation.

The iOS interop command is one serial E2E gate in the existing macOS workflow.
It writes separate MobileSafari and packaged-Tauri-WKWebView reports while
reusing the same external Python `RTCClient`, bilateral pairing, RPC/stream,
reconnect, revocation, HTTP-disabled, and redaction assertions. The packaged
test app embeds only the browser harness, declares no external binaries or
resources, and is scanned for forbidden Python/sidecar paths. Passing simulator
reports remain pending until the macOS job runs; physical-device
direct/STUN/TURN evidence is separate.

## Thin WebRTC rollout controls

The frontend rollout gates default to enabled so existing profiles retain
their current behavior:

| Variable | Effect when set to `0`, `false`, `no`, or `off` |
| --- | --- |
| `VITE_AURORA_WEBRTC_THIN_CLIENT` | Prevents new WebRTC sessions. `webrtc-preferred` uses its configured HTTP endpoint; `webrtc-only` remains fail-closed. Desktop-local sidecar mode is unchanged. |
| `VITE_AURORA_WEBRTC_SCOPED_SUBSCRIPTIONS` | Removes `scoped_event_subscriptions_v1` from the local protocol hello. |
| `VITE_AURORA_WEBRTC_FRAGMENTATION` | Removes both `fragmentation_v1` and `backpressure_v1` from the local protocol hello. |
| `VITE_AURORA_WEBRTC_APP_LAYER_E2EE` | Disallows optional app-layer E2EE locally. Profiles that require E2EE fail closed instead of sending plaintext. |

These are Vite build inputs. Rebuild the thin artifact to change them. The
kill switch does not delete or translate stored peer or HTTP credentials, so
re-enabling it does not require a credential migration.

## One-command desktop development

From the repository root, the normal dev command is enough to start Vite, the Tauri Rust shell, and the local Aurora Python services in threads mode. This command is the real local development stack; fixture/demo fallbacks are explicitly labeled separately and are not acceptance evidence for desktop-local behavior:

```bash
pnpm --filter @aurora/tauri-ui tauri dev
```

The package wrapper selects `.venv/bin/python` when it exists; otherwise it falls back to `uv run --no-dev --extra sidecar-thin python main.py` from the repository root. It sets `AURORA_ARCHITECTURE_MODE=threads`, enables the managed local sidecar, and points the UI at `http://127.0.0.1:8000`. You should not need to run `prepare:sidecar`, build a PyInstaller sidecar, or export `AURORA_TAURI_SIDECAR_SOURCE` for day-to-day development.

Dev logging is intentionally unified in the same terminal:

- Vite logs appear from the Tauri CLI dev server and should be labelled `[vite]` when separated by smoke harnesses.
- Rust/Tauri wrapper and shell logs use the `[tauri]` prefix.
- Python Aurora service logs are piped by the Rust sidecar supervisor with `[aurora][stdout]` and `[aurora][stderr]` prefixes.
- Explicit Gateway readiness probes use `[gateway]` when a dev smoke harness separates API health output.
- Desktop-local is not shown as ready until the Tauri sidecar status command succeeds and the SDK can read `/api/health`, `/api/registry`, and a core read-only `/api/services` sample through the Gateway boundary.
- Ctrl-C forwards shutdown to the Tauri child process; closing the Tauri window stops the supervised Python sidecar.

Packaged desktop builds still use the profiled sidecar staging flow described below; the direct Python sidecar path is for local development and diagnostics. Rust launches a bundled sidecar from the platform Tauri application-data directory and sets its `AURORA_CONFIG_FILE`, `AURORA_ENV_FILE`, and `AURORA_DATA_DIR` there. Configuration, migrated secrets, and the database therefore persist across one-file extraction directories and app restarts without requiring write access to the installation directory.

Desktop local sidecar defaults:

- program: `python`
- args: `main.py`
- cwd: repository root
- Gateway URL: `http://127.0.0.1:8000`
- config: generated from `app/services/config/config_defaults.json` with Gateway enabled and bound to the selected loopback host/port, passed to Python via `AURORA_CONFIG_FILE`

Override with `AURORA_TAURI_SIDECAR_PROGRAM`, `AURORA_TAURI_SIDECAR_ARGS`, `AURORA_TAURI_SIDECAR_CWD`, `AURORA_TAURI_SIDECAR_CONFIG_FILE`, or `AURORA_GATEWAY_URL` when packaging provides a bundled Python entrypoint.


## CI/E2E route gates

The lightweight Linux-safe gates below run in Vitest/jsdom and are intended for pull-request CI before any GUI or platform-specific Tauri smoke. They fail if the Tauri shell regresses to placeholder or debug-only UI, if admin/runtime routes fall back to broad route-registry placeholders, or if non-data runtime routes are falsely privacy-blocked.

```bash
pnpm --filter @aurora/tauri-ui test:e2e:routes
pnpm --filter @aurora/tauri-ui test:e2e:assistant
pnpm --filter @aurora/tauri-ui test:e2e:admin
pnpm --filter @aurora/tauri-ui test:e2e:runtime
pnpm --filter @aurora/tauri-ui test:e2e:outcomes
pnpm --filter @aurora/tauri-ui tauri:smoke:linux
```

`test:e2e:outcomes` mounts the Tauri shell in jsdom, waits for AuroraClient-backed state, follows real shell navigation, records invoked backend method names, verifies visible SDK error states, and writes static HTML review artifacts to `apps/aurora-tauri/reports/e2e-outcomes/`. It is a Linux-safe outcome gate, not a replacement for final desktop/WebView screenshot evidence.

`tauri:smoke:linux` is a deterministic headless aggregate of the route gates above. It does not launch a desktop webview and does not replace `pnpm --filter @aurora/tauri-ui tauri dev` or the platform-specific Android/iOS/native smoke checks.

`dev:smoke` is the desktop/WebView smoke wrapper used by the Linux Tauri workflow under Xvfb. It launches `pnpm --filter @aurora/tauri-ui tauri dev`, fails if the process exits before readiness, fails if `/api/health`, `/api/registry`, or `/api/services` never become reachable, fails if required `[tauri]`/`[aurora][...]` log markers are missing, and writes `apps/aurora-tauri/reports/tauri-dev-smoke.json`.

## Local operator smoke checklist

Use this sequence when preparing a Tauri/UI quality gate from a normal checkout:

```bash
pnpm install --frozen-lockfile
pnpm --filter @aurora/client build
pnpm --filter @aurora/ui build
pnpm --filter @aurora/tauri-ui test
pnpm --filter @aurora/tauri-ui typecheck
pnpm --filter @aurora/tauri-ui tauri:smoke:linux
```

Then run the interactive desktop-local stack or CI smoke wrapper when a GUI environment is available:

```bash
pnpm --filter @aurora/tauri-ui tauri dev
pnpm --filter @aurora/tauri-ui dev:smoke
```

`tauri:smoke:linux` delegates to `test:ci-regression-gates`, a fast policy/outcome gate. `dev:smoke` is the bounded desktop-local evidence command. The final gate should preserve `apps/aurora-tauri/reports/tauri-dev-smoke.json`, `apps/aurora-tauri/reports/e2e-outcomes/`, route screenshots when available, Android/iOS preflight reports, and review/architecture approvals. Mark missing external-platform evidence as pending instead of treating this README or Linux-only tests as approval.

## Secure storage

`aurora_secure_storage_get`, `aurora_secure_storage_set`, and `aurora_secure_storage_delete` persist only Aurora credential keys in the platform keychain through the Rust shell. Accepted keys are limited to `aurora.session*`, `aurora.auth*`, `aurora.gateway*`, `aurora.mesh*`, and `aurora.admin*` namespaces for session tokens, refresh material, mesh credentials, Gateway tokens, and admin unlock secrets.

The Tauri shell and SDK transport do not use `localStorage`, `sessionStorage`, or plaintext files for these values. The secure-storage commands return redacted metadata (`backend=platform-keychain`, `persisted=true`, `secretsRedacted=true`) and only return a secret value to the explicit `secureStorageGet` caller.

iOS builds expose the same storage posture through the Aurora native plugin in `src-tauri/ios/`: thin peer credentials are stored as device-only, non-synchronizing generic-password Keychain items under hashed peer accounts; reconnect proof is computed natively with the canonical `mesh_auth_proof_v1` HMAC transcript; only metadata/proof is returned. Nonsecret connection profiles use `UserDefaults`. Keychain status, Face ID/Touch ID status, and admin unlock confirmation remain app-owned native capability evidence. Admin unlock is confirmation-only and still expects backend AdminAction confirmation/audit for admin-critical mutations. The iOS app must include `NSFaceIDUsageDescription`, and `tauri ios build`/Xcode simulator or device validation must run on macOS before release.

## Packaging And Updates

Tauri bundling is enabled for Linux AppImage/deb by default, macOS dmg, and Windows MSI/NSIS targets. RPM is explicit via `build:bundle:linux-rpm:desktop-local-minimal` or the Python-free `build:bundle:linux-rpm:thin` on RPM-capable runners. Default local/CI bundle scripts pass `--no-sign`; secret-backed release builds create updater artifacts and signatures through Tauri's updater configuration.

Release inputs:

- `AURORA_TAURI_SIDECAR_PROFILE`: optional local-sidecar profile override; defaults to `desktop-local-minimal`. Supported user-facing profiles are `desktop-local-minimal`, `local-cpu`, `local-cuda`, `local-rocm`, `local-metal`, `local-vulkan`, `local-sycl`, `local-rpc`, and `full`.
- `AURORA_TAURI_SIDECAR_SOURCE`: optional trusted prebuilt Aurora sidecar override for CI cache/artifact reuse. If unset, `prepare:sidecar` builds the selected profile automatically from `dist/sidecars/<profile>/aurora-sidecar` or by invoking the Python builder in an isolated `uv --no-dev` environment.
- `AURORA_TAURI_TARGET_TRIPLE`: optional override for cross-build sidecar naming; defaults to the host Rust target triple.
- `AURORA_TAURI_THIN_CONNECTION_MODE`: `http-only`, `webrtc-only`, or `webrtc-preferred` for thin package wrappers.
- `AURORA_TAURI_ALLOWED_REMOTE_ORIGINS`, `AURORA_TAURI_ANDROID_ALLOWED_REMOTE_ORIGINS`, and `AURORA_TAURI_IOS_ALLOWED_REMOTE_ORIGINS`: space-separated exact secure origins required by the selected thin mode. The platform-specific variables take precedence on Android/iOS.
- `TAURI_SIGNING_PRIVATE_KEY`: required by Tauri when producing signed updater artifacts. Use a secure CI secret or a local secret path/content.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: optional signing key password.

The updater public key and endpoint in `src-tauri/tauri.conf.json` are release placeholders. A production release must replace `AURORA_RELEASE_PUBLIC_KEY_REPLACE_BEFORE_RELEASE` with the generated public key content and point the HTTPS endpoint at the signed release metadata service before publishing.

```bash
pnpm --filter @aurora/tauri-ui prepare:sidecar:desktop-local-minimal
pnpm --filter @aurora/tauri-ui build
pnpm --filter @aurora/tauri-ui build:bundle:desktop-local
pnpm --filter @aurora/tauri-ui build:bundle:desktop-thin
```

Use `build:bundle:desktop-thin` (or its Python-free compatibility alias `build:bundle:thin`) for the remote desktop shell. It writes `src-tauri/tauri.thin.conf.json`, runs Tauri with that flavor overlay, requires only the exact `https://` and/or `wss://` CSP origins needed by the selected mode, injects only nonsecret default endpoints into the initial profile, replaces desktop-local capabilities with `aurora-thin`, omits `bundle.externalBin` and `bundle.resources`, and runs `verify:bundle:desktop-thin`. A `webrtc-only` package accepts WSS signaling alone and leaves the Gateway URL empty. Profile changes are loaded/saved asynchronously and close/recreate the shared WebView HTTP/WebRTC runtime. Authentication remains in the live SDK session; no build-time bearer fallback exists. `build:bundle` aliases `build:bundle:desktop-local`, whose minimal sidecar profile is `desktop-local-minimal`. See `docs/TAURI_DESKTOP_BUILD.md` for the full build flow.

## Android preflight

Android uses the official Tauri mobile project and plugin model. Run `pnpm --filter @aurora/tauri-ui tauri android init` before strict Android release verification so the generated Android project exists under Tauri's `gen/android` path. The native capability manifest is still the UI source of truth: assistant-role availability must come from Android RoleManager/package qualification probes, not from the Tauri shell existing.

Release commands:

```bash
pnpm --filter @aurora/tauri-ui android:build:aab
pnpm --filter @aurora/tauri-ui android:build:apk
pnpm --filter @aurora/tauri-ui android:preflight
pnpm --filter @aurora/tauri-ui android:preflight:ci
pnpm --filter @aurora/tauri-ui android:preflight:strict
```

`android:preflight` writes `apps/aurora-tauri/reports/android-preflight.json` with the expected AAB/APK commands, signing readiness, native plugin payload matrix, and device matrix rows for thin, mesh, assistant-role-capable, and fallback devices. Non-strict mode is CI-safe before Android SDK/emulator/signing are present. `android:preflight:ci` requires the generated Android project after `android:init` but does not require release signing, so pull-request APK smoke can build unsigned debug APKs. `android:preflight:strict` remains the release-readiness gate and fails when the generated Android project or signing inputs are missing.

Signing inputs are intentionally environment-only and redacted in reports:

- `ANDROID_KEYSTORE_PATH` or `TAURI_ANDROID_KEYSTORE_PATH`: path to CI/local release keystore material.
- `AURORA_ANDROID_SIGNING_CONFIGURED=1`: explicit assertion that CI has injected the complete Android signing config.

Google Play release readiness requires a signed AAB from `android:build:aab`, Play Console app-signing setup, and manual first upload or a release-manager Google Play Developer API workflow. APK builds with `--split-per-abi` are for emulator/device smoke and non-Play distribution evidence.

Minimum Android release evidence:

- Emulator/device native plugin payload recorded from `Native.GetCapabilityManifest`.
- Assistant role probe records `roleAvailable`, `packageQualified`, `roleHeld`, `requestable`, `denied`, and `oemUnavailable`.
- Fallback entrypoints such as app launcher, notification action, share sheet, deep link, shortcut/tile, or mesh/server routing remain available when the assistant role is not held.
- Settings UI shows Android assistant-role and fallback states only from the native manifest payload.

## iOS policy and signing preflight

iOS release evidence is tracked by `src-tauri/ios/preflight.json` and exposed through the SDK native manifest shape. The approved user-facing copy is `Siri/Shortcuts/App Intents integration`; UI copy must not claim that Aurora becomes the iOS system assistant.

Policy checks can run on any platform:

```bash
pnpm --filter @aurora/tauri-ui ios:policy
```

The actual iOS build and signing gate requires macOS with Xcode and the generated Tauri iOS project:

```bash
pnpm --filter @aurora/tauri-ui tauri ios init
pnpm --filter @aurora/tauri-ui ios:preflight
export AURORA_TAURI_IOS_ALLOWED_REMOTE_ORIGINS="https://gateway.example wss://signaling.example"
pnpm --filter @aurora/tauri-ui ios:build:thin:simulator
pnpm --filter @aurora/tauri-ui ios:open-xcode
```

`ios:build:thin:simulator` is the supported thin-shell build entrypoint. It rejects wildcard, insecure, credential-bearing, and non-root remote origins; generates a temporary Tauri overlay with only the exact origins required by the selected mode; removes external binaries and sidecar resources; and writes `reports/ios-thin-simulator-build-provenance.json` only after a successful Xcode simulator build. For direct-peer-only packaging, use `AURORA_TAURI_IOS_ALLOWED_REMOTE_ORIGINS="wss://signaling.example"` with `AURORA_TAURI_THIN_CONNECTION_MODE=webrtc-only`; no Gateway origin is required. The checked-in `tauri.ios-thin.conf.json` is a policy template, not an operator endpoint configuration.

The App Store/TestFlight dry run also requires App Store Connect credentials in CI or an external macOS runner:

```bash
export APPLE_API_KEY_ID=...
export APPLE_API_ISSUER=...
export APPLE_API_KEY_PATH=/secure/path/AuthKey_XXXX.p8
pnpm --filter @aurora/tauri-ui ios:build:app-store
```

Required QA evidence for IOS-008:

- `tauri ios build` or `ios:preflight` log from macOS/Xcode.
- Simulator or device invocation of the native manifest plugin and at least one App Intent/Shortcut flow.
- Simulator or device share/deep-link flow with backend attachment validation or a policy-blocked result.
- App Store Connect/TestFlight signing dry run or explicit credential-gated substitute evidence.
- No raw Apple API key material, provisioning secret, token, local model path, or unredacted payload in logs or screenshots.

## Platform capability matrix

| Platform | Local command / CI lane | Capability evidence | Release limits |
| --- | --- | --- | --- |
| Web thin | Web app checks in `frontend-sdk.yml`; `pnpm test:webrtc:interop`; `pnpm test:webrtc:turn`; `pnpm test:webrtc:browsers` | HTTP/Gateway SDK transport plus direct, configured-STUN, and forced-TURN WebRTC DataChannel RPC/events live-proven in Chromium, Firefox, and Playwright WebKit. | Packaged WebView, page suspension, physical-device, and production-scale browser/network certification remain separate evidence. |
| Desktop local | `pnpm --filter @aurora/tauri-ui tauri dev`; `dev:smoke` in `tauri-desktop.yml` | Rust-supervised Python sidecar, loopback Gateway, secure storage/native command status, unified logs. | Dev path does not use packaged sidecar staging. |
| Desktop packaged local | `build:bundle:desktop-local`, `build:bundle:desktop-local-minimal`, or another explicit local `build:bundle:<profile>` | Profile-specific sidecar staged into Tauri external binaries. | Local/CI scripts pass `--no-sign`; signing/notarization are release-only. |
| Desktop packaged thin | `build:bundle:desktop-thin`; `verify:bundle:desktop-thin` | Python-free Tauri shell with mode-specific exact HTTPS Gateway and/or WSS signaling configuration and AppImage/deb artifact proof report. WSS-only packaging is supported for `webrtc-only`. | Requires the operator-managed endpoint(s) selected by mode; no local wakeword/background Python service ownership. |
| Android | `android:init`, `android:preflight:ci`, `android:build:thin:apk`, `android:verify:thin:apk`, `android:build:thin:aab`, `android:verify:thin:aab`, `android:smoke`, `android:webrtc:interop` | Android thin APK/AAB artifact proof; native manifest payloads for assistant role, fallback entrypoints, Keystore peer credentials/proofs, biometric/admin unlock, foreground WebView mic policy, lifecycle, and device matrix; one API 35 job runs packaged System WebView and standalone Chrome pairing against the external Python peer. | Passing KVM/physical mobile WebRTC reports remain pending; release AAB/signing needs keystore inputs and Play/App Distribution workflow. |
| iOS thin policy/source | `ios:policy` | Shared WebView HTTP/WebRTC routing, least-privilege thin capability/overlay, device-only Keychain peer credential/proof adapter, nonsecret profile storage, and no default system-assistant claim. | Linux-safe source/policy evidence only; not a simulator/device WebRTC result. |
| iOS build/preflight | `tauri ios init`, `ios:build:thin:simulator`, `ios:smoke:simulator`, `ios:webrtc:interop`, `tauri ios build`, `ios:preflight` | macOS/Xcode generated project and simulator build/runtime lanes for baseline plus Python-free thin overlay; one serial E2E runs the complete external-Python direct-path protocol in MobileSafari and a packaged Tauri WKWebView app; App Intent/share/deep-link/file evidence runs when targets exist. | Requires macOS/Xcode; passing MobileSafari and packaged-WKWebView reports are still pending; physical-device STUN/TURN smoke remains required; App Store/TestFlight dry run requires Apple credentials. |

## Commands

```bash
pnpm --filter @aurora/tauri-ui build
pnpm --filter @aurora/tauri-ui tauri dev
pnpm --filter @aurora/tauri-ui ios:policy
pnpm --filter @aurora/tauri-ui verify:bundle:desktop-thin
pnpm --filter @aurora/tauri-ui android:verify:thin:apk
pnpm --filter @aurora/tauri-ui android:verify:thin:aab
pnpm --filter @aurora/tauri-ui ios:webrtc:interop
pnpm test:webrtc:interop
pnpm test:webrtc:turn
pnpm test:webrtc:browsers
cd apps/aurora-tauri/src-tauri && cargo check
cd apps/aurora-tauri/src-tauri && cargo test
```

## iOS Baseline

IOS-001 establishes the Tauri iOS build baseline and native-manifest contract. The manifest exposes iOS invocation states through `Native.GetCapabilityManifest` as evidence, not as executable backend truth:

- `Siri/Shortcuts/App Intents integration`: planned App Intents for concrete Aurora actions.
- `Shortcuts invocation path`: supported platform path once the iOS plugin and Xcode targets exist.
- `iOS share extension intake`: app-owned share extension entrypoint for text, URL, and file metadata handoff.
- `iOS deep links`: `aurora://` and associated-link launch paths for app-owned Aurora flows.
- `iOS widgets`: widget actions that open Aurora entrypoints without running assistant orchestration in the extension process.
- `iOS file associations`: Tauri mobile file associations for selected text, markdown, JSON, and `.aurora` context exports.
- `System assistant role`: unsupported. Aurora must present Siri/Shortcuts/App Intents integration only and must not claim default iOS assistant ownership.

Linux can run the TypeScript/Rust manifest checks, but cannot satisfy the iOS build acceptance gate. macOS/Xcode verification must run:

```bash
pnpm --filter @aurora/tauri-ui build
pnpm --filter @aurora/tauri-ui tauri ios init
pnpm --filter @aurora/tauri-ui tauri ios build
```

The `Tauri iOS Baseline` GitHub Actions workflow runs this baseline on macOS with Xcode, CocoaPods, and the required Rust iOS targets. Use that workflow's `macOS Xcode Tauri iOS init and build` job as IOS-001 build evidence for pull requests. The CI baseline builds the unsigned iOS simulator target with `pnpm --filter @aurora/tauri-ui tauri ios build --target aarch64-sim --config src-tauri/tauri.ios.conf.json`; the default device/archive build requires Apple signing credentials and remains a separate App Store/TestFlight release dry-run gate once Apple team credentials and native iOS targets are ready.

The iOS baseline uses `src-tauri/tauri.ios.conf.json` and the `aurora-ios-baseline` capability so mobile builds do not request desktop-only updater permissions. Desktop builds continue to use `aurora-main` plus the desktop-only `aurora-desktop-updater` capability from the Linux, macOS, and Windows platform config files.

IOS-004 extends `src-tauri/ios/AuroraNativePlugin/`, the Swift package linked by the official Tauri iOS plugin model. Its `Plugin` subclass exposes `nativeCapabilityManifest`, `invocationStatus`, `iosEntrypointPayload`, and `invokeAuroraAction` commands with redacted payload metadata. The Swift package is not a replacement for the Xcode-managed App Intent, share extension, widget extension, associated-domain, or file-open wiring; those generated targets must call back through the SDK/backend handoff path.

The iOS Tauri overlay declares `bundle.fileAssociations` in `src-tauri/tauri.ios.conf.json`. Tauri projects those declarations into generated mobile metadata, while iOS App Intents/share/widget targets remain Xcode-managed extension work.

After IOS-002/IOS-003/IOS-004 add the Swift plugin and Xcode-managed App Intent/share/widget targets, the macOS check must also smoke-test simulator/device invocation of one App Intent or Shortcut and one share/deep-link/file-open flow. Do not duplicate Aurora orchestration logic in Swift; native entrypoints bridge to the SDK/backend.

## Android thin baseline

Android support now includes an official Tauri mobile generated project, synced Kotlin native plugin, and Python-free Android thin APK/AAB build lane. Android thin reuses the shared WebView HTTP/WebRTC runtime; the native layer supplies capability evidence, Keystore-backed peer credential/proof storage, foreground WebView microphone policy, lifecycle release policy, and platform entrypoints.

```bash
pnpm --filter @aurora/tauri-ui android:init
pnpm --filter @aurora/tauri-ui android:preflight:ci
pnpm --filter @aurora/tauri-ui android:build:thin:apk
pnpm --filter @aurora/tauri-ui android:verify:thin:apk
pnpm --filter @aurora/tauri-ui android:build:thin:aab
pnpm --filter @aurora/tauri-ui android:verify:thin:aab
pnpm --filter @aurora/tauri-ui android:smoke
```

Current artifact proof passes for the generated debug APK and AAB and reports no Python/sidecar content. The shared Tauri capability intentionally does not grant `updater:default`; updater artifact generation remains desktop packaging configuration, not a WebView permission. Local Android runtime smoke still requires Java, Android SDK/NDK, an emulator or physical device, and KVM/device access where applicable. If those are absent, mark runtime smoke as pending rather than claiming device proof.

## Android native capability plugin

`src-tauri/android/aurora-native-plugin/` contains the Android Kotlin plugin used by the native capability manifest. The plugin exposes Android-native evidence commands for `nativeCapabilityManifest`, `assistantRoleStatus`, assistant-role request probing, fallback entrypoints, Android Keystore-backed secure storage, thin peer credential set/status/delete/reconnect proof, biometric/device-credential admin unlock status/request, WebView microphone permission decisions, lifecycle status, foreground-service readiness, and redacted entrypoint payloads. `Native.GetCapabilityManifest` routes through this plugin on Android, so the SDK receives explicit Android states for assistant role, mic, notifications, biometric, secure storage, admin unlock, local network, foreground service, file, share/deep-link, widget, shortcut, quick tile, and fallback entrypoints. Share sheet and deep-link entrypoints are native-declared open/intake paths, but backend context ingestion must still prove any user content was processed.

Android secure storage uses an app-private `SharedPreferences` payload encrypted by an AES-GCM key generated in Android Keystore. Accepted keys are limited to Aurora credential namespaces. Thin peer credential commands store scoped reconnect material and return proof/status metadata without exposing raw long-lived secrets through generic getters. Reconnect proof uses the canonical `mesh_auth_proof_v1` HMAC message shared with Python/TypeScript fixtures and must not emit legacy `proof_hmac_sha256`.

Android foreground WebView microphone policy requires a trusted HTTPS or `tauri.localhost` origin, `RECORD_AUDIO`, foreground, and focus. Lifecycle status sets `backgroundWakeword=false` and reports when the WebView must release the microphone. This is not a durable background wakeword/audio pipeline claim.

Android admin unlock is exposed as capability evidence and a request command through `aurora_biometric_admin_unlock_status` and `aurora_biometric_admin_unlock`. It uses Android keyguard/biometric capability evidence and starts the platform credential confirmation intent when requestable. UI must treat it as `admin-critical` and permission-gated until the native payload reports an available/requestable state.

The real Android build remains gated on Tauri's generated Android project under `src-tauri/gen/android`; run `pnpm --filter @aurora/tauri-ui tauri android init` before attempting `pnpm --filter @aurora/tauri-ui tauri android build` in an Android-capable environment.

## Scope Boundary

The frontend must use `AuroraClient`; screens must not call Tauri `invoke` except through the SDK transport adapter or this package's runtime bootstrap. Secure credential storage is enabled through the narrow Aurora keychain/Keystore command surface only. File access, native audio, event subscription streaming, and broad shell/fs permissions remain disabled or explicitly unsupported until their dedicated follow-up tasks.
## Canonical docs

- [Frontend and UI architecture](../../docs/FRONTEND_AND_UI_ARCHITECTURE.md)
- [Tauri desktop build](../../docs/TAURI_DESKTOP_BUILD.md)
- [Feature matrix](../../docs/FEATURE_MATRIX.md)
