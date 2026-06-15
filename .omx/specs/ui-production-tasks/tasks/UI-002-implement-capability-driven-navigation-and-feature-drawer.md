# UI-002 — Implement capability-driven navigation and feature drawer

## Execution metadata

- **Phase:** P6 — Product UI shell and cross-cutting UX
- **Lane:** ui-shell
- **Depends on:** UI-001, SDK-006
- **Parallelizable with:** None
- **Coverage matrix rows:** admin.overview
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Drive nav badges, disabled states, and repair actions from the capability graph.

## User-visible outcome

Every unavailable feature explains missing service/permission/native capability and next action.

## Backend/API implementation details

- Consume existing/new backend only through SDK; keep unsupported backend features disabled with capability explanation.

## SDK integration details

- Use `AuroraClient` APIs and capability graph; no direct fetch/invoke in screen components.

## Tauri/native integration details

- No Tauri/native work is expected in this task. Native capabilities must be consumed through the SDK/native manifest produced by the relevant `TAURI-*`, `AND-*`, or `IOS-*` task.

## UI/UX implementation details

- Replace fixture `capabilityFeatures` with SDK graph.
- Show repair actions: authenticate, pair, grant permission, start service, configure route, install plugin.
- Persist user choices for route/privacy defaults through SDK policy config.

## Code references to inspect first

- Future production UI package/routes/components
- Reference mock component files listed below.

## Mock/component references

- `components/aurora/admin/overview.tsx` capability graph section
- `components/aurora/capability-drawer.tsx`
- `lib/aurora/data.ts` capabilityFeatures

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
