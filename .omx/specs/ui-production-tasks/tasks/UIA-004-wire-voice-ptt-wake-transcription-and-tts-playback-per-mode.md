# UIA-004 — Wire voice PTT, wake, transcription, and TTS playback per mode


<!-- UI-BRANCH-POLICY -->
## UI branch and sequencing policy

- **Target implementation branch:** `feat/ui-multi-platform-integration`.
- Do not start production UI implementation from these tasks until the mesh-gap sequence is complete through `MESH-GAP-011` and `MESH-GAP-012` has refreshed UI/SDK tasks against the finalized mesh contracts.
- The UI branch should be created from the accepted `feat/mesh-full-services-integrations` result, not from stale `main` or the old migration branch.
- UI tasks may only be used as planning/reference before that gate; production wiring waits for final capability catalog, route explain, aggregate tooling, approval protocol, data/RAG, audio, scheduler, audit, and diagnostics contracts.

## Execution metadata

- **Phase:** P7 — Assistant UI production wiring
- **Lane:** assistant-voice
- **Depends on:** UIA-001, UI-004, SDK-006, MESH-GAP-008
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

- Use `AuroraClient` APIs and executable capability catalog projections; no direct fetch/invoke or diagnostic graph-only execution in screen components.

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

<!-- MESH-PRODUCTION-GAP-ADDENDUM -->
## Mesh production gap addendum

This task is expanded by `MESH-GAP-008` for cross-peer audio boundaries.

Additional requirements:

- Show explicit session consent before sending microphone/audio frames to a remote peer for STT, wake, or TTS-related routing.
- Distinguish batch transcription/synthesis from remote microphone, wakeword streaming, live transcription, and remote playback/control. Batch remote operations may use capability catalog route decisions; live/streaming or hardware-targeting operations require audio session prepare/consent/start/status/stop contracts.
- Display local capture vs remote processing vs local playback as separate state chips.
- RouteSheet must expose audio privacy class, peer/provider, transport, retention policy, session TTL, and cancel/revoke control.
- Event stream UI must handle partial transcription, final transcription, timeout, cancelled, remote denial, peer disconnect, and local permission loss.
- Remote playback/TTS must not silently target a peer's hardware without explicit selector and consent.

Additional acceptance criteria:

- Component tests cover local STT, remote STT, remote denied, consent revoked mid-session, peer disconnect, and mobile foreground-only limitations.
