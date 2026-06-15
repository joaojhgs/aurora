# UIA-003 — Wire tool approval cards and tool-result display

## Execution metadata

- **Phase:** P7 — Assistant UI production wiring
- **Lane:** assistant-tools
- **Depends on:** UIA-001, SDK-013, BE-011
- **Parallelizable with:** None
- **Coverage matrix rows:** assistant.tool.approval
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Make tool execution transparent and permission/privacy aware.

## User-visible outcome

User sees tool risk, inputs, data-egress, approval/deny reason, progress, result, and audit receipt.

## Backend/API implementation details

- Consume existing/new backend only through SDK; keep unsupported backend features disabled with capability explanation.

## SDK integration details

- Use `AuroraClient` APIs and capability graph; no direct fetch/invoke in screen components.

## Tauri/native integration details

- No Tauri/native work is expected in this task. Native capabilities must be consumed through the SDK/native manifest produced by the relevant `TAURI-*`, `AND-*`, or `IOS-*` task.

## UI/UX implementation details

- Use SDK tool metadata/risk taxonomy.
- Approval calls route through AdminAction when tool is mutating/external/admin; lower-risk approvals still emit audit/decision event if backend requires.
- Validate arguments against tool schema and show read-only diff/result.

## Code references to inspect first

- Future production UI package/routes/components
- Reference mock component files listed below.

## Mock/component references

- `components/aurora/assistant/tool-call-card.tsx`
- `components/aurora/admin-confirm-dialog.tsx`
- `modules/ui-mock-reference/app/(cockpit)/tools/page.tsx`

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
