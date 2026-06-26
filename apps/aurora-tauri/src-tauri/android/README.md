# Aurora Android Native Plugin Skeleton

This directory holds the Android side of the future Aurora Tauri mobile plugin. It follows the official Tauri 2 mobile plugin shape: Kotlin native code extends `app.tauri.plugin.Plugin`, is annotated with `@TauriPlugin`, and exposes methods annotated with `@Command`.

The skeleton is intentionally evidence-only. It reports Android package, permission, role, and fallback-entrypoint state to the Rust/JS bridge, but it does not claim assistant-role availability, microphone capture, notification delivery, or foreground-service behavior without Android OS evidence.

## Commands

- `nativeCapabilityManifest`: returns Android native capability and permission states for SDK/native manifest ingestion. The payload keeps backward-compatible boolean `permissions`/`capabilities` maps and also includes `permissionStates`/`capabilityStates` so UI can distinguish `available`, `needs_native_permission`, `unsupported_platform`, `degraded`, and `fallback`.
- `assistantRoleStatus`: probes `RoleManager.ROLE_ASSISTANT` on Android Q+ and package qualification hints from the manifest/intent surface.
- `requestAssistantRole`: starts the Android role request only when the OS role is available and the package appears qualified.
- `fallbackEntrypoints`: returns push-to-talk/share/deep-link fallback availability so UI can keep non-role flows visible.
- `recordAssistantRoleResult`: records a grant/denial result code after a role request smoke test or future activity-result hook.

## Native Manifest Fields

The Android provider reports status for:

- assistant-role availability, package qualification, held state, requestability, denial, OEM/platform unavailability, and fallback availability;
- microphone, notifications, biometric, local-network, foreground-service microphone, local file read/write/pick, share intent, deep link, and fallback entrypoints;
- redacted evidence source `android-rolemanager-package-manager`.

File read/write/pick are reported as `degraded` until a scoped Android file/share intake task wires a native picker contract. Foreground service microphone remains `needs_native_permission` until both microphone and foreground-service microphone permission evidence is present. Fallback entrypoints remain present when the assistant role is not held.

## Emulator Smoke

After Tauri Android generation wires this module into the app, smoke test with an emulator/device:

```bash
pnpm --filter @aurora/tauri-ui tauri android build
adb install apps/aurora-tauri/src-tauri/gen/android/app/build/outputs/apk/debug/app-debug.apk
adb shell cmd role holders android.app.role.ASSISTANT
```

Then call the JS transport command path for `getNativeCapabilityManifest()` / `androidAssistantRoleStatus` or invoke the plugin command from the Tauri mobile shell test harness and record the returned payload. Expected results must distinguish `roleAvailable`, `packageQualified`, `roleHeld`, `requestable`, `denied`, and `oemUnavailable`; include mic/notification/biometric/local-network/foreground-service/file/share states; and keep fallback entrypoints present when `roleHeld=false`.

The CI smoke harness reads chunked `aurora_android_native_plugin_payload_*` log markers and reassembles them before JSON validation. Do not rely on a single full-payload logcat line; Android log output can truncate long JSON lines before the parser sees them.
