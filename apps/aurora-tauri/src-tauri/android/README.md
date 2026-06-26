# Aurora Android Native Plugin Skeleton

This directory holds the Android side of the future Aurora Tauri mobile plugin. It follows the official Tauri 2 mobile plugin shape: Kotlin native code extends `app.tauri.plugin.Plugin`, is annotated with `@TauriPlugin`, and exposes methods annotated with `@Command`.

The skeleton is intentionally evidence-only. It reports Android package, permission, role, and fallback-entrypoint state to the Rust/JS bridge, but it does not claim assistant-role availability, microphone capture, notification delivery, or foreground-service behavior without Android OS evidence.

## Commands

- `nativeCapabilityManifest`: returns Android native capability and permission states for SDK/native manifest ingestion.
- `assistantRoleStatus`: probes `RoleManager.ROLE_ASSISTANT` on Android Q+ and package qualification hints from the manifest/intent surface.
- `requestAssistantRole`: starts the Android role request only when the OS role is available and the package appears qualified.
- `fallbackEntrypoints`: returns push-to-talk/share/deep-link fallback availability so UI can keep non-role flows visible.
- `recordAssistantRoleResult`: records a grant/denial result code after a role request smoke test or future activity-result hook.

## Emulator Smoke

After Tauri Android generation wires this module into the app, smoke test with an emulator/device:

```bash
pnpm --filter @aurora/tauri-ui tauri android build
adb install apps/aurora-tauri/src-tauri/gen/android/app/build/outputs/apk/debug/app-debug.apk
adb shell cmd role holders android.app.role.ASSISTANT
```

Then call the JS transport command path for `androidAssistantRoleStatus` or invoke the plugin command from the Tauri mobile shell test harness and record the returned payload. Expected results must distinguish `roleAvailable`, `packageQualified`, `roleHeld`, `requestable`, `denied`, and `oemUnavailable`, and fallback entrypoints must remain present when `roleHeld=false`.
