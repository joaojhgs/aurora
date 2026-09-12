# Aurora Android Native Plugin

This directory holds the production Android side of Aurora's Tauri mobile
plugin. It follows the official Tauri 2 mobile plugin shape: Kotlin native code
extends `app.tauri.plugin.Plugin`, is annotated with `@TauriPlugin`, and exposes
methods annotated with `@Command`.

The plugin reports Android package, permission, role, and fallback-entrypoint
state to the Rust/JS bridge and contains the native foreground path: one
reference-counted `AuroraRuntimeForegroundService` carries microphone capture
and held device connections behind a single notification. Kotlin owns
AudioRecord/AudioTrack, role entrypoints, and lifecycle controls; Rust owns the
bounded voice and mesh sessions, per-peer queue/liveness state, typed Gateway
routing, cancellation, and redacted status. Waydroid has exercised this path
against the real `main.py` service, including background device-link serving,
force-stop/restart recovery, and assistant turns. Physical-device Doze, OEM
kill policy, battery, and thermal qualification remain separate release gates.

`pnpm android:sync-native-plugin` copies this source into the generated Tauri
Android app and applies the canonical Aurora manifest fragments. The app
declares `INTERNET`, `ACCESS_NETWORK_STATE`, `RECORD_AUDIO`,
`MODIFY_AUDIO_SETTINGS`, `POST_NOTIFICATIONS`, `FOREGROUND_SERVICE`,
`FOREGROUND_SERVICE_MICROPHONE`, `FOREGROUND_SERVICE_CONNECTED_DEVICE`, and
`USE_BIOMETRIC`; the official barcode
scanner plugin contributes `CAMERA` and `VIBRATE`. The Android thin build also
selects `aurora-mobile-mesh`, which authorizes the scanner's permission and scan
commands. Dangerous camera/microphone/notification grants still remain
user-controlled Android runtime permissions.

Aurora vendors the lockfile-selected barcode-scanner plugin version because the
upstream Android `cancel` implementation tears down its saved scan invocation
before rejecting it. The one-line lifecycle correction captures the pending
invocation first, tears down the camera surface, and then rejects the pending
scan as cancelled. This keeps QR cancellation silent and lets onboarding leave
its pending state. Do not patch the generated Gradle copy: Tauri regenerates
that path during every mobile build.

## Commands

- `nativeCapabilityManifest`: returns Android native capability and permission states for SDK/native manifest ingestion. The payload keeps backward-compatible boolean `permissions`/`capabilities` maps and also includes `permissionStates`/`capabilityStates` so UI can distinguish `available`, `needs_native_permission`, `unsupported_platform`, `degraded`, and `fallback`.
- `assistantRoleStatus`: probes `RoleManager.ROLE_ASSISTANT` on Android Q+ and package qualification evidence from the enabled `ACTION_ASSIST` activity plus enabled `VoiceInteractionService` declaration with `BIND_VOICE_INTERACTION` and `android.voice_interaction` metadata.
- `requestAssistantRole`: starts the Android role request only when the OS role is available and the package appears qualified.
- `requestAndroidPermission`: requests Android runtime permissions for microphone, notifications, or foreground voice controls when the permission is runtime-requestable.
- `voiceForegroundServiceStatus`: reports microphone, notification, manifest, foreground-service readiness, running state, and raw-audio privacy constraints.
- `startVoiceForegroundService` / `stopVoiceForegroundService`: starts or stops the privacy-visible foreground service used for native voice capture and playback. The service uses the Rust session when native-only voice credentials are provisioned and retains a bounded capture-only migration path otherwise; backend/model and device evidence are still required before product readiness is advertised.
- `fallbackEntrypoints`: returns push-to-talk/share/deep-link/widget/shortcut/quick-tile fallback availability so UI can keep non-role flows visible.
- `entrypointPayload`: returns the last redacted Android intent payload recorded by the native entrypoint activity, widget, or quick tile.
- `localLightInferenceStatus`: reports the Android local-light inference provider adapter as native manifest evidence. It remains `degraded` until backend model catalog evidence, device/model proof, and a real provider implementation are present; fallback providers stay visible.
- `recordAssistantRoleResult`: records a grant/denial result code after a role request smoke test or future activity-result hook.

## Native Manifest Fields

The Android provider reports status for:

- assistant-role availability, package qualification, held state, requestability, denial, OEM/platform unavailability, fallback availability, and the separate `handlesAssistActivity` / `declaresVoiceInteractionService` qualification signals;
- microphone, microphone requestability, notifications, notification requestability, biometric, local-network, foreground-service microphone, foreground voice service startability/running state, local file read/write/pick, share intent, deep link, app widget, app shortcut, quick tile, redacted entrypoint payload, and fallback entrypoints;
- `entrypoints` descriptors for share sheet, selected text, deep links, static shortcuts, home-screen widget, and Quick Settings tile, including whether the native manifest declares the surface and whether backend intake is required before Aurora may claim action success;
- local-light inference provider state for `native:mobile-local-light`, including fallback availability, model-runtime proof requirement, redacted evidence source, and a `degraded` state until a real device/model-backed provider exists;
- redacted evidence source `android-rolemanager-package-manager`.

File read/write/pick are reported as `degraded` until a scoped Android file/share intake task wires a native picker contract. Foreground service microphone remains `needs_native_permission` until both microphone and foreground-service microphone permission evidence is present. The foreground service only proves an Android OS foreground constraint and notification channel path; UI must still require backend audio/session evidence before claiming listening/transcription. Share sheet and deep links are native-declared but still require backend context ingestion before UI can claim that a file, URL, or message was processed. Widget, shortcut, and quick tile entrypoints are fallback open paths whose placement and invocation remain user/OEM controlled. Fallback entrypoints remain present when the assistant role is not held.

## Waydroid and emulator smoke

After Tauri Android generation wires this module into the app, use Waydroid as
the normal local target and select its serial from `adb devices -l`. Build and
install the generated package before probing the role/capability surface:

```bash
pnpm --filter @aurora/tauri-ui tauri android build
adb -s "$WAYDROID_SERIAL" install apps/aurora-tauri/src-tauri/gen/android/app/build/outputs/apk/debug/app-debug.apk
adb -s "$WAYDROID_SERIAL" shell cmd role holders android.app.role.ASSISTANT
```

Then call the JS transport command path for `getNativeCapabilityManifest()` / `androidAssistantRoleStatus`, `localLightInferenceStatus`, `requestAndroidPermission('aurora.android.microphone')`, `voiceForegroundServiceStatus`, and `entrypointPayload`, or invoke the plugin commands from the Tauri mobile shell test harness and record the returned payload. Expected results must distinguish `roleAvailable`, `packageQualified`, `roleHeld`, `requestable`, `denied`, and `oemUnavailable`; include mic/notification/biometric/local-network/foreground-service/foreground-voice/file/share/deep-link/widget/shortcut/quick-tile states; include local-light inference as `degraded` with backend model catalog and device/model proof requirements; include redacted entrypoint descriptors and `lastEntrypointPayload`; and keep fallback entrypoints present when `roleHeld=false`.

The CI smoke harness reads the native capability manifest through the packaged
Tauri command boundary after the WebView is ready. Chunked
`aurora_android_native_plugin_payload_*` log markers remain corroborating
diagnostics and are reassembled before validation when present. Do not rely on
a single full-payload logcat line; Android log output can truncate long JSON
lines before the parser sees them.

For mesh/background/assistant acceptance, run the maintained package scripts
only after Python, SDK, UI, and Rust suites pass. The live server must be the
full `uv run python main.py` stack; a mock server is not acceptance evidence.
Use clean app state for pairing/revocation recovery claims, keep one explicit
device serial, and retain the redacted report. Rerun this expensive gate on an
integration branch only when its source delta can affect Android native, Rust
mesh/voice session, SDK pairing/transport, foreground-service, or lifecycle
behavior.
