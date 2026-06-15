# UI-001 — Build production app shell, routes, navigation, and design tokens

## Execution metadata

- **Phase:** P6 — Product UI shell and cross-cutting UX
- **Lane:** ui-shell
- **Depends on:** P0-003, SDK-001
- **Parallelizable with:** None
- **Coverage matrix rows:** sdk.transport.client
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Create production UI shell from the visual reference system.

## User-visible outcome

User sees unified assistant/admin/runtime shell on web and Tauri with responsive desktop/mobile navigation.

## Backend/API implementation details

- Consume existing/new backend only through SDK; keep unsupported backend features disabled with capability explanation.

## SDK integration details

- Use `AuroraClient` APIs and capability graph; no direct fetch/invoke in screen components.

## Tauri/native integration details

- No Tauri/native work is expected in this task. Native capabilities must be consumed through the SDK/native manifest produced by the relevant `TAURI-*`, `AND-*`, or `IOS-*` task.

## UI/UX implementation details

- Implement route structure for assistant, memory, tools, mesh, admin, models, diagnostics, onboarding, settings.
- Migrate/copy design system tokens, badges, cards, tables, sheets, dialogs, mobile tabs.
- Create skeleton/error boundaries and layout-level capability/auth gates.

## Code references to inspect first

- Future production UI package/routes/components
- Reference mock component files listed below.

## Mock/component references

- `components/aurora/app-shell.tsx`
- `lib/aurora/nav.ts`
- `modules/ui-mock-reference/app/(cockpit)/layout.tsx`
- `components/aurora/status-badges.tsx`

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
