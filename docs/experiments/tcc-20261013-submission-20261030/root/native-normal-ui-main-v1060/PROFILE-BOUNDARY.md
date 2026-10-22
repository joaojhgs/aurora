# V1064 desktop-local onboarding boundary

Status: **blocked at the existing profile contract; no source or test patch was authored.** This is a source-only finding, not a runtime result. A UI-only change would expose a choice that the current controller cannot persist as a valid desktop-local Python-full profile.

## Evidence

- `apps/aurora-tauri/src/tauri-app.tsx:1437-1442` only enters first-run onboarding when `requiresOnboarding`, `thinPeer`, and `thinProfileController` are all present. Desktop-local has no `thinPeer`. Its earlier local return is `apps/aurora-tauri/src/aurora-client.ts:1150-1174`.
- `apps/aurora-tauri/src/tauri-app.tsx:979-984` returns successfully from `applyModePreference` when either the thin profile or controller is missing. `packages/aurora-ui/src/onboarding-view.tsx:327-337` then marks setup done after a successful callback; when the callback is absent it also marks setup done. This needs fail-closed handling, but that alone cannot create the profile.
- The runtime-backed controller at `apps/aurora-tauri/src/aurora-client.ts:2221-2295` persists profiles through `saveProfile(profile)`, which converts a *thin connection profile*. Its `runtimeProfileFromThinProfile` path at `:2558-2627` requires a complete home/WebRTC connection for `mesh-node`.
- The only connection-free profile factory in that controller is `createOfflineProfile` at `apps/aurora-tauri/src/aurora-client.ts:2297-2395`. It explicitly rejects non-mobile Tauri, creates only a `lightweight-ts` profile with the sole `local-inference` capability pack, and verifies that exact shape after store readback.
- Shared profile validation at `packages/aurora-ui/src/runtime-profile.ts:393-443,515-548` requires `meshMembership` for `mesh-node` profiles except the specific offline lightweight-ts/local-inference profile. `isRuntimeProfileConfigured` at `:287-300` likewise only treats that narrow offline shape as configured. Therefore a `python-full` profile cannot be made valid by merely setting the runtime tier or onboarding preference.
- The UI preference store also does not share the controller’s in-memory runtime-backed selection on desktop-local: `createAuroraTauriRuntime` constructs `runtimeModePreferenceStore` for the controller (`aurora-client.ts:781-786`) but returns `secureModePreferenceStore` for desktop-local (`:1170-1173`). Aligning those stores is necessary, but still does not supply the missing profile creation contract.

## Smallest supported next action

Add an explicit desktop-local profile transaction to the existing runtime-profile controller, with a source-supported way to establish the local node identity and valid local runtime membership/configuration. It must retain the existing bundled-Python proof gate, sanitize and save through the runtime profile store, read back and verify the active profile, and only then allow onboarding to finish and rebuild normal readiness. If desktop Python-full is intended to run without mesh membership, that needs an explicit shared profile-contract decision and corresponding validation semantics; this candidate does not relax the current invariant. Once that transaction exists, wire desktop-local onboarding to it, expose onboarding without requiring a remote peer, pass the same selected-mode store to UI and controller, and make a missing/failed callback keep setup incomplete with an error.

No stable local identity or valid Python-full/no-home-connection membership factory was found in the assigned controller path. The existing mobile identity-inspection command is used only by the mobile lightweight-ts factory; reusing it with fabricated membership or broadening its contract would be a new behavior not supported by the inspected path. Consequently no focused passing save/rebuild regression can be written honestly yet. The needed next regression should exercise the new real controller transaction: selected local mode -> persisted/read-back active Python-full profile -> runtime rebuild/readiness; and verify a failed store/capability/profile operation does not mark onboarding complete.

## Source pins

- `apps/aurora-tauri/src/aurora-client.ts` SHA-256 `f315ffc77530a460a73789f707f83c29e903fe9c4845a1da2a1c559160fabe31`
- `apps/aurora-tauri/src/tauri-app.tsx` SHA-256 `edfbf868d97bd1e0257aa88211b95e4bf9af7ddacebc130b3940238ad9156c5a`
- `packages/aurora-ui/src/runtime-profile.ts` SHA-256 `ee5d41a3acabbb20cc6a34c8f8408181ef8f0402b6822bba4d8a9adf7e522d18`
- `packages/aurora-ui/src/onboarding-view.tsx` SHA-256 `03199bd782770350296485b33b9f65c9a5e2363edeb49256fc7e28c06c3e8135`

No source changes, tests, builds, or runtime actions were performed.
