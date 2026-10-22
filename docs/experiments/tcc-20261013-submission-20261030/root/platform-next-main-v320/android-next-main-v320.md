# Android next main gate (V320)

## Finding

The shortest maintained packaged-Android main selector is the existing `AURORA_ANDROID_MAIN_FLOW_ONLY=1` path in `scripts/run-android-native-turn-ui-acceptance.mjs`. It runs the real native voice acceptance on the installed app, and only after voice setup/turn/cleanup succeeds invokes `runAndroidLocalInferenceMainFlow` against the same installed WebView. That second phase creates an owned offline profile through onboarding, checks the production-selected local model (`chat-qwen3-0b8`) and readiness, enables offline answers, forces the packaged WebView offline, submits an Assistant turn, then reopens the saved conversation and requires the same answer. Existing wrapper logic retains the original fatal outcomes and cleanup checks.

Run only after Root’s lock/reservation and supported device-host route are ready. The maintained workflow invokes the existing selector as `AURORA_ANDROID_MAIN_FLOW_ONLY=1 AURORA_THREE_NODE_BROKER_URL=<owned broker endpoint> node apps/aurora-tauri/scripts/run-android-native-turn-ui-acceptance.mjs`, with `AURORA_ANDROID_APK` set to the run-owned voice-live APK. The wrapper requires that broker endpoint to stage the real voice peer. The selector disables extra stall/Doze coverage, so it is not background acceptance. The workflow’s API-35 emulator invocation is source evidence for the selector, not evidence of a Waydroid run.

## Artifact and device route

Current checkout is `5782746afba213f6b36907db2f09f0017625e218`. No `.apk` or `.aab` was present under the checked `apps/aurora-tauri`, `.artifacts`, `.git/aurora-validation`, or `.artifacts/implementation` paths. The latest retained APK observation (`ORCA-ANDROID-APK-OBSERVATION-V11.json`, SHA-256 `572d1c03bee21638ff9f7a6fb966fc1ef4d1e02d8bbd2cbc02aa29e0c470aec8`) still records its build terminal as running; it is not a completed artifact receipt and supplies no usable APK hash/source match. Thus there is no packaged current-source artifact to reuse or claim as exercised.

The approved device route is present: `ORCA-V309-ANDROID-ROUTE-COORDINATION.json` confirms booted Waydroid through the existing personal-distrobox SSH host/serial route. The exact monitor report path named in the task (`mesh-readiness-and-android-route-20261014T0659.md`) was not found; this route-coordination record is the available current handoff. The V211 emulator guide permits controller-routed screenshot/AX/launch/permissions/logcat on its approved SSH device, but explicitly excludes APK install and raw `exec` over that proxy. Its local SDK/ADB path is host-owned. Therefore the bounded gap is artifact production and installation from the owning environment through the approved device path, not device absence; Root must retain that build/install step and confirm artifact hash/source before invoking the acceptance selector.

## Remaining evidence boundary

The main selector covers foreground native speech/voice and offline typed Assistant response plus saved-history reopen. It intentionally skips the smoke’s screen-off/Doze branch. Background acceptance remains a later separate gate: the Android guidance requires the same authorized peer’s Rust session snapshots, foreground-service `connectedDevice` reason, `background_tool_call` marker, and Gateway outcome; `scripts/android-background-measurement.mjs` is a measurement harness, not a substitute for that semantic acceptance. Do not infer physical-device Doze/OEM behavior from Waydroid.

The retained V58 “existing mains” record is only a passing Vitest source test (`src/android-voice-live-smoke.test.ts`, three named setup/background-policy cases; exit 0), not an APK/device run. `ANDROID-EXACT-CURRENT-CHECK-V58.json` remains `in_progress`, so it is not a pass. The V319 nine-cell campaign is a separate hosted matching campaign and provides no Android artifact or packaged-device result.

## Source and guidance anchors

- `apps/aurora-tauri/package.json` SHA-256 `27a424f7936c1951aa32ceb4d2c2daf17af5d7adbb10297b0cf7937c97cc646e`
- `apps/aurora-tauri/scripts/build-android-client-bundle.mjs` SHA-256 `6bc4cadfcec4d22a384f293f86877b6b0066e277e6165a3c924199b891b6ef87`
- `apps/aurora-tauri/scripts/run-android-native-turn-ui-acceptance.mjs` SHA-256 `7a28bf11c94e9e83a91007865e49fe95482a6763a6fd052f19ad1a43b1c4057b`
- `apps/aurora-tauri/scripts/android-local-inference-main-flow.mjs` SHA-256 `063d82cb21739e4b3a75930d1b5c2e37f2cbdef6546b956a3e595553055409e4`
- `apps/aurora-tauri/scripts/android-voice-live-smoke.mjs` SHA-256 `cb5c86d8929e1db16b9acb1664e00627b1ecdaa76f6859d804a4d209491e47f4`
- `apps/aurora-tauri/scripts/android-background-measurement.mjs` SHA-256 `fdaa50884b296c383546f830c933bb535071e5b983d00f357279a4589b77b391`
- `apps/aurora-tauri/scripts/android-emulator-smoke-runner.mjs` SHA-256 `ea2ea835baeefbd67fb5d48268abe5859f398208f26caf129dd0c2a29a45082e`
- `.github/workflows/tauri-android.yml` SHA-256 `73411d7cde44a72a08d4ca331c8a1c77f56910b244e5d9391b36f2cfc0b15d0f`
- Approved emulator guide `ORCA-EMULATOR-ANDROID-SKILL-V211.md` SHA-256 `4de175839cbcfbe01d5e87069510592cfcfa06cf832c12adb06a3a3ca9de724e`
- Available device coordination record `ORCA-V309-ANDROID-ROUTE-COORDINATION.json` SHA-256 `8f434a53ef1cb337e8e79ceed455a0f5e14dbbbdee2118ec0782a3d188e667f2`
- Prior narrow source-test record `ANDROID-ROUTE-EXISTING-MAINS-V58.json` SHA-256 `f5da1afc10410ebfef0f835ed2d880540c92c2b8df71ea62f9e2f5d44dff267c`

No source, index, test, or device state was changed by this lookup.
