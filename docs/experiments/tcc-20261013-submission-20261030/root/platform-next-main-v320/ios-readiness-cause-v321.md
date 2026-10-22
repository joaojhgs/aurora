# V321 iOS native speech-readiness source trace

## Finding

The retained current failure is a real readiness failure, not an architecture or app-launch failure and not an inference failure. Run `38170326712`, job `114561426020`, reports an observed speech-readiness poll with `speechReadinessProfileSelected=false`, `speechReadinessAvailable=false`, and `speechReadinessActiveSttMatches=false`. The simulator selected, installed, and launched the app; host/app architecture agreed. No model setup, PCM, transcript, or final answer was reached. The primary-log SHA is `d18c6174263ce2355df9483fb3a7a88cca04bfc06528f01e908290b3d6c089f9`; it is not an app-binary hash. Safe summary: `.git/aurora-handoff-import-20261006/ios-current-failure-v165/safe-summary.json` (SHA-256 `76de278c364e91319b4080f319b68dff331c3f46452f8ca762c59b2395073b5f`).

## Maintained execution path

The existing `.github/workflows/tauri-ios.yml` opts into this gate only with `native_voice_main_flow: true` (step at lines 236–242). Its CI wrapper builds a fresh debug `aarch64-sim` Tauri app with the dedicated `tauri.ios-voice-live-test.conf.json`, resolves that `.app`, smoke-installs/launches it on a selected booted simulator, starts the owned Gateway helper, then passes the exact app path and simulator UDID to the native flow. The test-control origin and configuration are loopback/private. This identifies the intended artifact path, but the retained safe summary does not contain the app bundle/native-library hash or built source revision; the primary log SHA must not be treated as that mapping.

The frontend test driver first validates an empty owned profile, selects the arm64 Cactus local-inference engine/model metadata, checks native speech catalog availability, creates the runtime profile, and prepares speech. `prepareSpeech` filters STT entries by acknowledgement, platform/architecture compatibility, reference requirements, and manifest digest/revision. If the active profile’s STT selection differs, it uses the actual Settings transcription picker, then waits for three conditions: persisted profile selection equals the chosen STT, native readiness is available, and the active native STT slot equals that same choice. The gate intentionally fails closed when any condition is false.

The iOS native status producer makes `available=false` meaningful: `AuroraIOSVoicePackManager.statusLocked()` requires both a connected configured runtime (`isRuntimeConnected()` probes the configured Gateway) and at least one active pack that resolves as ready. The SDK adapter passes `available` and `activeSlots` into `getReadiness`; it does not synthesize success from catalog presence. Thus the current booleans directly show a profile-selection mismatch, an unavailable native speech state, and a nonmatching/missing active STT slot. They do **not** distinguish whether the selection was not persisted, the selected pack failed activation/readiness, or the runtime connectivity portion of aggregate availability failed. No specific repair is grounded without that distinction and without mapping the failing run to the built app/native libraries.

## Bounded conclusion and handoff

No source patch is proposed. The exact remaining gap is the failing run’s artifact/source mapping plus the source-supported failure subcause behind the three false readiness predicates. The workflow and driver are maintained and exercised; no new workflow, broader matrix, readiness relaxation, or timeout change is warranted by this report. Root should keep the normal current-ref artifact/source receipt with the existing opted-in job result and use the existing Settings/profile and native status boundary to decide whether a specific repair is justified. The prior baseline’s skipped native step and any source-only test are not a pass for this gate.

## Source anchors

- `.github/workflows/tauri-ios.yml` — SHA-256 `9ddc4a2dc36a63d9e0face26a1edaa25a91fc4d6f31e00addd4c250062485a00`
- `apps/aurora-tauri/scripts/ios-voice-main-flow-ci.mjs` — SHA-256 `235f5021762fc4b32118a26f70e6b032ca91ca950ae46ee15bf044263d10ec3e`
- `apps/aurora-tauri/src/ios-voice-main-flow.ts` — SHA-256 `4503c34468cd9d4a09eb2cc93d50094af0d6d3574a4850457e05d872e02a20db`
- `apps/aurora-tauri/src/native-speech-catalog.ts` — SHA-256 `5b2e996b71cb7856256572fc8f11ced837236d9cf1c0ce73b567c449ebb7777c`
- `apps/aurora-tauri/src-tauri/ios/AuroraNativePlugin/Sources/AuroraNativePlugin/AuroraIOSVoicePackManager.swift` — SHA-256 `e407f158b6de35337dc1cd09b162cb539e86ded620d927a2a0b024225894ca27`
- Retained V165 safe summary — SHA-256 `76de278c364e91319b4080f319b68dff331c3f46452f8ca762c59b2395073b5f`

This was read-only source/report preparation. No source, index, CI, simulator, model, or goal state was changed.
