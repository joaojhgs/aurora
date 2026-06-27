# Aurora Tauri Shell

This package is the official Tauri 2 desktop shell for Aurora. It hosts the production React UI and keeps Aurora service state behind `AuroraClient`.

## Modes

- Desktop local: uses the Tauri IPC bridge to start, monitor, and stop a Rust-supervised Python thread-mode sidecar while UI data still flows through `AuroraClient`.
- Desktop thin: set `AURORA_TAURI_REMOTE_GATEWAY_URL` and `AURORA_TAURI_ALLOW_REMOTE_GATEWAY=1` for the Rust bridge to proxy SDK requests to a remote Gateway without a sidecar.
- Browser development fallback: `VITE_AURORA_GATEWAY_URL` selects HTTP transport; no Gateway URL uses SDK mock fixtures.

Desktop local sidecar defaults:

- program: `python`
- args: `main.py`
- cwd: repository root
- Gateway URL: `http://127.0.0.1:8000`
- config: generated from `app/services/config/config_defaults.json` with Gateway enabled and bound to the selected loopback host/port, passed to Python via `AURORA_CONFIG_FILE`

Override with `AURORA_TAURI_SIDECAR_PROGRAM`, `AURORA_TAURI_SIDECAR_ARGS`, `AURORA_TAURI_SIDECAR_CWD`, `AURORA_TAURI_SIDECAR_CONFIG_FILE`, or `AURORA_GATEWAY_URL` when packaging provides a bundled Python entrypoint.

## Secure storage

`aurora_secure_storage_get`, `aurora_secure_storage_set`, and `aurora_secure_storage_delete` persist only Aurora credential keys in the platform keychain through the Rust shell. Accepted keys are limited to `aurora.session*`, `aurora.auth*`, `aurora.gateway*`, `aurora.mesh*`, and `aurora.admin*` namespaces for session tokens, refresh material, mesh credentials, Gateway tokens, and admin unlock secrets.

The Tauri shell and SDK transport do not use `localStorage`, `sessionStorage`, or plaintext files for these values. The secure-storage commands return redacted metadata (`backend=platform-keychain`, `persisted=true`, `secretsRedacted=true`) and only return a secret value to the explicit `secureStorageGet` caller.

## Packaging And Updates

Tauri bundling is enabled for Linux AppImage/deb/rpm, macOS dmg, and Windows MSI/NSIS targets. Release builds create updater artifacts and signatures through Tauri's updater configuration.

Release inputs:

- `AURORA_TAURI_SIDECAR_SOURCE`: required path to a prebuilt Aurora sidecar executable before `tauri build`.
- `AURORA_TAURI_TARGET_TRIPLE`: optional override for cross-build sidecar naming; defaults to the host Rust target triple.
- `TAURI_SIGNING_PRIVATE_KEY`: required by Tauri when producing signed updater artifacts. Use a secure CI secret or a local secret path/content.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: optional signing key password.

The updater public key and endpoint in `src-tauri/tauri.conf.json` are release placeholders. A production release must replace `AURORA_RELEASE_PUBLIC_KEY_REPLACE_BEFORE_RELEASE` with the generated public key content and point the HTTPS endpoint at the signed release metadata service before publishing.

```bash
pnpm --filter @aurora/tauri-ui prepare:sidecar
pnpm --filter @aurora/tauri-ui build
pnpm --filter @aurora/tauri-ui build:bundle
```

`prepare:sidecar` copies the explicit sidecar artifact into `src-tauri/binaries/aurora-sidecar-$TARGET_TRIPLE` because Tauri expects target-triple suffixed external binaries at bundle time. It also writes the ignored `src-tauri/tauri.release.conf.json` overlay that adds `bundle.externalBin` for `build:bundle`. The default `tauri.conf.json` intentionally omits `externalBin` so `cargo check` and smoke CI can run without release-only sidecar artifacts.

## Android Release Gate

Android uses the official Tauri mobile project and plugin model. Run `pnpm --filter @aurora/tauri-ui tauri android init` before strict Android release verification so the generated Android project exists under Tauri's `gen/android` path. The native capability manifest is still the UI source of truth: assistant-role availability must come from Android RoleManager/package qualification probes, not from the Tauri shell existing.

Release commands:

```bash
pnpm --filter @aurora/tauri-ui android:build:aab
pnpm --filter @aurora/tauri-ui android:build:apk
pnpm --filter @aurora/tauri-ui android:release-gate
pnpm --filter @aurora/tauri-ui android:release-gate:strict
```

`android:release-gate` writes `apps/aurora-tauri/reports/android-release-gate.json` with the expected AAB/APK commands, signing readiness, native plugin payload matrix, and device matrix rows for thin, mesh, assistant-role-capable, and fallback devices. Non-strict mode is CI-safe before Android SDK/emulator/signing are present. Strict mode fails when the generated Android project or signing inputs are missing.

Signing inputs are intentionally environment-only and redacted in reports:

- `ANDROID_KEYSTORE_PATH` or `TAURI_ANDROID_KEYSTORE_PATH`: path to CI/local release keystore material.
- `AURORA_ANDROID_SIGNING_CONFIGURED=1`: explicit assertion that CI has injected the complete Android signing config.

Google Play release readiness requires a signed AAB from `android:build:aab`, Play Console app-signing setup, and manual first upload or a release-manager Google Play Developer API workflow. APK builds with `--split-per-abi` are for emulator/device smoke and non-Play distribution evidence.

Minimum Android release evidence:

- Emulator/device native plugin payload recorded from `Native.GetCapabilityManifest`.
- Assistant role probe records `roleAvailable`, `packageQualified`, `roleHeld`, `requestable`, `denied`, and `oemUnavailable`.
- Fallback entrypoints such as app launcher, notification action, share sheet, deep link, shortcut/tile, or mesh/server routing remain available when the assistant role is not held.
- Settings UI shows Android assistant-role and fallback states only from the native manifest payload.

## Commands

```bash
pnpm --filter @aurora/tauri-ui build
pnpm --filter @aurora/tauri-ui tauri dev
cd apps/aurora-tauri/src-tauri && cargo check
cd apps/aurora-tauri/src-tauri && cargo test
```

## iOS Baseline

IOS-001 establishes the Tauri iOS build baseline and native-manifest contract. The manifest exposes iOS invocation states through `Native.GetCapabilityManifest` as evidence, not as executable backend truth:

- `Siri/Shortcuts/App Intents integration`: planned App Intents for concrete Aurora actions.
- `Shortcuts invocation path`: supported platform path once the iOS plugin and Xcode targets exist.
- `Share, widgets, and deep links`: planned app-owned intake surfaces.
- `Siri replacement`: unsupported. Aurora must not claim it can replace Siri as the default iOS assistant.

Linux can run the TypeScript/Rust manifest checks, but cannot satisfy the iOS build acceptance gate. macOS/Xcode verification must run:

```bash
pnpm --filter @aurora/tauri-ui build
pnpm --filter @aurora/tauri-ui tauri ios init
pnpm --filter @aurora/tauri-ui tauri ios build
```

The `Tauri iOS Baseline` GitHub Actions workflow runs this baseline on macOS with Xcode, CocoaPods, and the required Rust iOS targets. Use that workflow's `macOS Xcode Tauri iOS init and build` job as IOS-001 build evidence for pull requests. The CI baseline builds the unsigned iOS simulator target with `pnpm --filter @aurora/tauri-ui tauri ios build --target aarch64-sim --config src-tauri/tauri.ios.conf.json`; the default device/archive build requires Apple signing credentials and remains a separate App Store/TestFlight release dry-run gate once Apple team credentials and native iOS targets are ready.

The iOS baseline uses `src-tauri/tauri.ios.conf.json` and the `aurora-ios-baseline` capability so mobile builds do not request desktop-only updater permissions. Desktop builds continue to use `aurora-main` plus the desktop-only `aurora-desktop-updater` capability from the Linux, macOS, and Windows platform config files.

After IOS-002/IOS-003/IOS-004 add the Swift plugin and Xcode-managed App Intent/share/widget targets, the macOS check must also smoke-test simulator/device invocation of one App Intent or Shortcut and one share/deep-link flow. Do not duplicate Aurora orchestration logic in Swift; native entrypoints bridge to the SDK/backend.

## Android Baseline

AND-001 keeps Android support at the official Tauri mobile build baseline. It does not implement the Aurora Android Kotlin feature plugin, assistant-role qualification, foreground audio service, share/deep-link intake, or secure mobile storage. The shell exposes `aurora_android_baseline_status` so emulator smoke tests can capture a redacted native payload. That payload keeps assistant-role fields unknown until a later RoleManager/VoiceInteractionService probe provides backend/native evidence.

```bash
pnpm --filter @aurora/tauri-ui android:init
pnpm --filter @aurora/tauri-ui android:build:apk:x86_64
pnpm --filter @aurora/tauri-ui android:build:apk:x86_64:debug
pnpm --filter @aurora/tauri-ui android:build:aab
pnpm --filter @aurora/tauri-ui android:smoke
```

The shared Tauri capability intentionally does not grant `updater:default`; updater artifact generation remains desktop packaging configuration, not a webview permission. Local Android builds require Java plus Android SDK/NDK/emulator components. The GitHub `Tauri Android Verification` workflow installs those prerequisites, initializes the generated `src-tauri/gen/android` project, builds an installable debug APK for emulator smoke, uploads the APK artifact, installs it on an emulator, launches Aurora, and records the `aurora_android_baseline_status` payload from logcat when available.

## Android Native Skeleton

`src-tauri/android/aurora-native-plugin/` contains the Android Kotlin plugin used by the native capability manifest. The plugin exposes Android-native evidence commands for `nativeCapabilityManifest`, `assistantRoleStatus`, assistant-role request probing, fallback entrypoints, Android Keystore-backed secure storage, biometric/device-credential admin unlock status/request, and a redacted `entrypointPayload`. `Native.GetCapabilityManifest` routes through this plugin on Android, so the SDK receives explicit Android states for assistant role, mic, notifications, biometric, secure storage, admin unlock, local network, foreground service, file, share/deep-link, widget, shortcut, quick tile, and fallback entrypoints. Share sheet and deep-link entrypoints are native-declared open/intake paths, but backend context ingestion must still prove any user content was processed.

Android secure storage uses an app-private `SharedPreferences` payload encrypted by an AES-GCM key generated in Android Keystore. The Tauri Rust command bridge keeps the existing `aurora_secure_storage_get`, `aurora_secure_storage_set`, and `aurora_secure_storage_delete` command names and routes them to the Android plugin on Android builds. Accepted keys are limited to `aurora.session*`, `aurora.auth*`, `aurora.gateway*`, `aurora.mesh*`, and `aurora.admin*`; command results include redacted metadata (`backend=android-keystore`, `persisted=true`, `secretsRedacted=true`).

Android admin unlock is exposed as capability evidence and a request command through `aurora_biometric_admin_unlock_status` and `aurora_biometric_admin_unlock`. It uses Android keyguard/biometric capability evidence and starts the platform credential confirmation intent when requestable. UI must treat it as `admin-critical` and permission-gated until the native payload reports an available/requestable state.

The real Android build remains gated on Tauri's generated Android project under `src-tauri/gen/android`; run `pnpm --filter @aurora/tauri-ui tauri android init` before attempting `pnpm --filter @aurora/tauri-ui tauri android build` in an Android-capable environment.

## Scope Boundary

The frontend must use `AuroraClient`; screens must not call Tauri `invoke` except through the SDK transport adapter or this package's runtime bootstrap. Secure credential storage is enabled through the narrow Aurora keychain/Keystore command surface only. File access, native audio, event subscription streaming, and broad shell/fs permissions remain disabled or explicitly unsupported until their dedicated follow-up tasks.
