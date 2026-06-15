# UIA-004 — Wire voice PTT, wake, transcription, and TTS playback per mode

## Execution metadata

- **Phase:** P7 — Assistant UI production wiring
- **Lane:** assistant-voice
- **Depends on:** UIA-001, UI-004, SDK-006
- **Parallelizable with:** AND-005, IOS-006, TAURI-005
- **Coverage matrix rows:** voice.audio.mode_matrix
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Implement voice without conflating local device audio and remote server audio.

## User-visible outcome

User can understand and use local capture, remote transcription, native playback, wake/background capabilities by mode/platform.

## Backend/API implementation details

- Consume existing/new backend only through SDK; keep unsupported backend features disabled with capability explanation.

## SDK integration details

- Use `AuroraClient` APIs and capability graph; no direct fetch/invoke in screen components.

## Tauri/native integration details

- No Tauri/native work is expected in this task. Native capabilities must be consumed through the SDK/native manifest produced by the relevant `TAURI-*`, `AND-*`, or `IOS-*` task.

## UI/UX implementation details

- Separate browser getUserMedia, Tauri desktop native capture, Android/iOS plugin capture, remote STT transcription, and local playback.
- This UI task does not wait for Android/iOS native plugins to land; native-only controls remain capability-gated until `AND-005`/`IOS-006` are available.
- Show wakeword unsupported/foreground-only states correctly.
- Add waveform/listening/permission-denied/no-device/error states.

## Code references to inspect first

- Future production UI package/routes/components
- Reference mock component files listed below.

## Mock/component references

- `components/aurora/assistant/assistant-view.tsx` VoiceCapture
- `components/aurora/settings/settings-permissions-view.tsx`

## Data, permissions, and privacy contract

- Use route/privacy/availability badges and AdminAction controller consistently.
- Include loading, empty, denied, degraded, unavailable, optimistic, and rollback/error states.

## Acceptance criteria

- Screen is responsive desktop/tablet/mobile.
- Feature visibility and buttons are capability-driven.
- All mutations use AdminAction if method_type manage/admin-critical.
- Component tests cover state matrix and SDK errors.

## Verification commands / evidence

- `pnpm --filter <ui-package> typecheck`
- `pnpm --filter <ui-package> test`
- `pnpm --filter <ui-package> build`
- Playwright/visual regression for primary happy/error states.

## Risks and guardrails

- Do not ship mock fixture data in production screens.
- Do not hide unsupported features without explaining repair/fallback.

## Handoff notes

- No additional handoff notes at planning time.
