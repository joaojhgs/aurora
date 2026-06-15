# AND-001 — Create Tauri Android build/emulator CI baseline

## Execution metadata

- **Phase:** P4 — Android native integration lane
- **Lane:** android-native
- **Depends on:** TAURI-001
- **Parallelizable with:** IOS-001, UI-004
- **Coverage matrix rows:** native.android.assistant_role, voice.audio.mode_matrix
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Implement Android-specific native capability safely inside official Tauri mobile architecture.

## User-visible outcome

Android APK/AAB builds and installs on emulator before feature plugins are added.

## Backend/API implementation details

- No backend contract changes are expected in this task. If implementation discovers a missing backend dependency, create/link the relevant `BE-*` task instead of widening this task silently.

## SDK integration details

- Expose Android states through `nativeCapabilityManifest` and capability graph; UI must display `available`, `needs_native_permission`, `unsupported_platform`, `degraded`, `fallback`.

## Tauri/native integration details

- Use Tauri mobile plugin model: Kotlin class extends `app.tauri.plugin.Plugin`, annotated with `@TauriPlugin`, command methods exposed to JS/Rust.
- Custom AndroidManifest/service declarations are allowed through the generated Android project/manifest merge path; keep declarations minimal and documented.

## UI/UX implementation details

- Settings/Permissions screen shows Android-specific assistant role, mic, notification, foreground service, share/deep-link and fallback states.

## Code references to inspect first

- Future Tauri Android project/plugin files
- `modules/ui-mock-reference/components/aurora/settings/settings-permissions-view.tsx`
- `modules/ui-mock-reference/components/aurora/onboarding/onboarding-view.tsx`
- `modules/ui-mock-reference/components/aurora/models/models-view.tsx`

## Mock/component references

- `modules/ui-mock-reference/components/aurora/settings/settings-permissions-view.tsx` androidStates
- `modules/ui-mock-reference/components/aurora/onboarding/onboarding-view.tsx` mode cards

## Data, permissions, and privacy contract

- Source: https://v2.tauri.app/develop/plugins/develop-mobile/
- Source: https://developer.android.com/reference/android/app/role/RoleManager
- Source: https://developer.android.com/reference/androidx/core/role/RoleManagerCompat
- Source: https://developer.android.com/reference/android/service/voice/VoiceInteractionService
- Source: https://developer.android.com/develop/ui/views/notifications

## Acceptance criteria

- Emulator smoke test records native plugin payload.
- Assistant role task distinguishes role available, package qualified, role held, requestable, denied, OEM unavailable.
- Fallback entrypoints remain available when role is not held.
- No UI claims assistant-role availability from Tauri shell alone.

## Verification commands / evidence

- `tauri android build` or chosen npm script.
- Install on emulator and call native capability command.
- For assistant role: adb/RoleManager probe demonstrates qualification state and expected grant/denial path.

## Risks and guardrails

- Android assistant role is conditional on OS/profile/OEM/user and package qualification.
- KVM-less emulators may be insufficient for WebView visual smoke; include physical/KVM matrix.

## Handoff notes

- No additional handoff notes at planning time.
