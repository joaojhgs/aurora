# AND-004 — Implement Android assistant-role qualification prototype


<!-- UI-BRANCH-POLICY -->
## UI branch and sequencing policy

- **Target implementation branch:** `feat/ui-multi-platform-integration`.
- Do not start production UI implementation from these tasks until the mesh-gap sequence is complete through `MESH-GAP-011` and `MESH-GAP-012` has refreshed UI/SDK tasks against the finalized mesh contracts.
- The UI branch should be created from the accepted `feat/mesh-full-services-integrations` result, not from stale `main` or the old migration branch.
- UI tasks may only be used as planning/reference before that gate; production wiring waits for final capability catalog, route explain, aggregate tooling, approval protocol, data/RAG, audio, scheduler, audit, and diagnostics contracts.

## Execution metadata

- **Phase:** P4 — Android native integration lane
- **Lane:** android-native
- **Depends on:** AND-002, AND-003
- **Parallelizable with:** None
- **Coverage matrix rows:** native.android.assistant_role, voice.audio.mode_matrix
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Implement Android-specific native capability safely inside official Tauri mobile architecture.

## User-visible outcome

Package declares qualifying manifest/service/activity entries and can request/check assistant role where available.

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
