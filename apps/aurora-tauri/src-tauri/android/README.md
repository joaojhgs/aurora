# Aurora Android Native Plugin Skeleton

This directory holds the Android side of the future Aurora Tauri mobile plugin. It follows the official Tauri 2 mobile plugin shape: Kotlin native code extends `app.tauri.plugin.Plugin`, is annotated with `@TauriPlugin`, and exposes methods annotated with `@Command`.

The skeleton is intentionally evidence-only. It reports Android package, permission, role, and fallback-entrypoint state to the Rust/JS bridge, but it does not claim assistant-role availability, microphone capture, notification delivery, or foreground-service behavior without Android OS evidence.

## Commands

- `nativeCapabilityManifest`: returns Android native capability and permission states for SDK/native manifest ingestion. The payload keeps backward-compatible boolean `permissions`/`capabilities` maps and also includes `permissionStates`/`capabilityStates` so UI can distinguish `available`, `needs_native_permission`, `unsupported_platform`, `degraded`, and `fallback`.
- `assistantRoleStatus`: probes `RoleManager.ROLE_ASSISTANT` on Android Q+ and package qualification evidence from the enabled `ACTION_ASSIST` activity plus enabled `VoiceInteractionService` declaration with `BIND_VOICE_INTERACTION` and `android.voice_interaction` metadata.
- `requestAssistantRole`: starts the Android role request only when the OS role is available and the package appears qualified.
- `requestAndroidPermission`: requests Android runtime permissions for microphone, notifications, or foreground voice controls when the permission is runtime-requestable.
- `voiceForegroundServiceStatus`: reports microphone, notification, manifest, foreground-service readiness, running state, and raw-audio privacy constraints.
- `startVoiceForegroundService` / `stopVoiceForegroundService`: starts or stops the minimal privacy-visible foreground service used for voice capture controls. This does not claim backend STT or continuous audio activity; backend audio evidence is still required.
- `fallbackEntrypoints`: returns push-to-talk/share/deep-link/widget/shortcut/quick-tile fallback availability so UI can keep non-role flows visible.
- `entrypointPayload`: returns the last redacted Android intent payload recorded by the native entrypoint activity, widget, or quick tile.
- `recordAssistantRoleResult`: records a grant/denial result code after a role request smoke test or future activity-result hook.

## Native Manifest Fields

The Android provider reports status for:

- assistant-role availability, package qualification, held state, requestability, denial, OEM/platform unavailability, fallback availability, and the separate `handlesAssistActivity` / `declaresVoiceInteractionService` qualification signals;
- microphone, microphone requestability, notifications, notification requestability, biometric, local-network, foreground-service microphone, foreground voice service startability/running state, local file read/write/pick, share intent, deep link, app widget, app shortcut, quick tile, redacted entrypoint payload, and fallback entrypoints;
- `entrypoints` descriptors for share sheet, selected text, deep links, static shortcuts, home-screen widget, and Quick Settings tile, including whether the native manifest declares the surface and whether backend intake is required before Aurora may claim action success;
- redacted evidence source `android-rolemanager-package-manager`.

File read/write/pick are reported as `degraded` until a scoped Android file/share intake task wires a native picker contract. Foreground service microphone remains `needs_native_permission` until both microphone and foreground-service microphone permission evidence is present. The foreground service only proves an Android OS foreground constraint and notification channel path; UI must still require backend audio/session evidence before claiming listening/transcription. Share sheet and deep links are native-declared but still require backend context ingestion before UI can claim that a file, URL, or message was processed. Widget, shortcut, and quick tile entrypoints are fallback open paths whose placement and invocation remain user/OEM controlled. Fallback entrypoints remain present when the assistant role is not held.

## Emulator Smoke

After Tauri Android generation wires this module into the app, smoke test with an emulator/device:

```bash
pnpm --filter @aurora/tauri-ui tauri android build
adb install apps/aurora-tauri/src-tauri/gen/android/app/build/outputs/apk/debug/app-debug.apk
adb shell cmd role holders android.app.role.ASSISTANT
```

Then call the JS transport command path for `getNativeCapabilityManifest()` / `androidAssistantRoleStatus`, `requestAndroidPermission('aurora.android.microphone')`, `voiceForegroundServiceStatus`, and `entrypointPayload`, or invoke the plugin commands from the Tauri mobile shell test harness and record the returned payload. Expected results must distinguish `roleAvailable`, `packageQualified`, `roleHeld`, `requestable`, `denied`, and `oemUnavailable`; include mic/notification/biometric/local-network/foreground-service/foreground-voice/file/share/deep-link/widget/shortcut/quick-tile states; include redacted entrypoint descriptors and `lastEntrypointPayload`; and keep fallback entrypoints present when `roleHeld=false`.

The CI smoke harness reads chunked `aurora_android_native_plugin_payload_*` log markers and reassembles them before JSON validation. Do not rely on a single full-payload logcat line; Android log output can truncate long JSON lines before the parser sees them.
