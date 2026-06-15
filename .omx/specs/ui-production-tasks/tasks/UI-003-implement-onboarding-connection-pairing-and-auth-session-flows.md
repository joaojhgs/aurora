# UI-003 — Implement onboarding, connection, pairing, and auth/session flows

## Execution metadata

- **Phase:** P6 — Product UI shell and cross-cutting UX
- **Lane:** ui-auth
- **Depends on:** UI-001, SDK-004, BE-001
- **Parallelizable with:** None
- **Coverage matrix rows:** auth.session.state_machine
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Create first-run and reconnect flows for every deployment mode.

## User-visible outcome

User can connect to server, local desktop sidecar, mesh peer, Android/iOS thin mode, or offline local mode with correct auth/pairing UX.

## Backend/API implementation details

- Consume existing/new backend only through SDK; keep unsupported backend features disabled with capability explanation.

## SDK integration details

- Use `AuroraClient` APIs and capability graph; no direct fetch/invoke in screen components.

## Tauri/native integration details

- No Tauri/native work is expected in this task. Native capabilities must be consumed through the SDK/native manifest produced by the relevant `TAURI-*`, `AND-*`, or `IOS-*` task.

## UI/UX implementation details

- Implement mode selection cards, endpoint validation, login, pairing code exchange, token restore, expired/revoked handling, offline/degraded fallback.
- Show API-key/SYSTEM mode only when auth disabled/local development explicitly reports it.
- Route post-login to cockpit with capability manifest refresh.

## Code references to inspect first

- Future production UI package/routes/components
- Reference mock component files listed below.

## Mock/component references

- `components/aurora/onboarding/onboarding-view.tsx`
- `components/aurora/admin/secondary-surface.tsx` PairingPanel
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
