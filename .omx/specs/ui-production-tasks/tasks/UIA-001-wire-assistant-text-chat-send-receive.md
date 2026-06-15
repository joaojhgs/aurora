# UIA-001 — Wire assistant text chat send/receive

## Execution metadata

- **Phase:** P7 — Assistant UI production wiring
- **Lane:** assistant
- **Depends on:** UI-001, UI-005, SDK-007
- **Parallelizable with:** None
- **Coverage matrix rows:** assistant.chat.text
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Implement basic assistant prompt flow over SDK before streaming complexity.

## User-visible outcome

User can send prompt and receive final response in server web, desktop thin, desktop local, and mesh/native-capable modes.

## Backend/API implementation details

- Consume existing/new backend only through SDK; keep unsupported backend features disabled with capability explanation.

## SDK integration details

- Use `AuroraClient` APIs and capability graph; no direct fetch/invoke in screen components.

## Tauri/native integration details

- No Tauri/native work is expected in this task. Native capabilities must be consumed through the SDK/native manifest produced by the relevant `TAURI-*`, `AND-*`, or `IOS-*` task.

## UI/UX implementation details

- Replace sampleMessages state with SDK session store.
- Use `client.assistant.sendMessage({text, routePolicy, sessionId})` and final result display.
- Persist conversation/session id and route/model/privacy badges.
- Handle loading, timeout, auth denied, service unavailable.

## Code references to inspect first

- Future production UI package/routes/components
- Reference mock component files listed below.

## Mock/component references

- `components/aurora/assistant/assistant-view.tsx`
- `components/aurora/assistant/route-sheet.tsx`

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
