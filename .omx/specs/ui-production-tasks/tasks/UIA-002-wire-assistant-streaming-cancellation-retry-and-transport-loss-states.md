# UIA-002 — Wire assistant streaming, cancellation, retry, and transport-loss states

## Execution metadata

- **Phase:** P7 — Assistant UI production wiring
- **Lane:** assistant
- **Depends on:** UIA-001, SDK-011, BE-003, BE-009
- **Parallelizable with:** None
- **Coverage matrix rows:** assistant.chat.streaming
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Upgrade assistant UX to live token/event stream with robust interruption.

## User-visible outcome

User can stop generation/tool/TTS where supported and retry or recover from stream disconnect.

## Backend/API implementation details

- Consume existing/new backend only through SDK; keep unsupported backend features disabled with capability explanation.

## SDK integration details

- Use `AuroraClient` APIs and capability graph; no direct fetch/invoke in screen components.

## Tauri/native integration details

- No Tauri/native work is expected in this task. Native capabilities must be consumed through the SDK/native manifest produced by the relevant `TAURI-*`, `AND-*`, or `IOS-*` task.

## UI/UX implementation details

- Display token stream, final event, cancel button, reconnect banner, replay from last known event, fallback to non-streaming response.
- Use cancellation capability state to disable fake stop buttons.

## Code references to inspect first

- Future production UI package/routes/components
- Reference mock component files listed below.

## Mock/component references

- `components/aurora/assistant/assistant-view.tsx`
- `components/aurora/activity-rail.tsx`

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
