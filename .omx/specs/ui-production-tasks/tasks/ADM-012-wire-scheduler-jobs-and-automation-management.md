# ADM-012 — Wire scheduler jobs and automation management


<!-- UI-BRANCH-POLICY -->
## UI branch and sequencing policy

- **Target implementation branch:** `feat/ui-multi-platform-integration`.
- Do not start production UI implementation from these tasks until the mesh-gap sequence is complete through `MESH-GAP-011` and `MESH-GAP-012` has refreshed UI/SDK tasks against the finalized mesh contracts.
- The UI branch should be created from the accepted `feat/mesh-full-services-integrations` result, not from stale `main` or the old migration branch.
- UI tasks may only be used as planning/reference before that gate; production wiring waits for final capability catalog, route explain, aggregate tooling, approval protocol, data/RAG, audio, scheduler, audit, and diagnostics contracts.

## Execution metadata

- **Phase:** P8 — Admin/operator dashboard production wiring
- **Lane:** admin
- **Depends on:** SDK-007, SDK-013, BE-018
- **Parallelizable with:** None
- **Coverage matrix rows:** scheduler.jobs
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Production-wire admin surface for `scheduler.jobs`.

## User-visible outcome

List/schedule/cancel/pause/resume jobs with permission and audit handling.

## Backend/API implementation details

- Consume existing/new backend only through SDK; keep unsupported backend features disabled with capability explanation.
- Pause/resume must stay disabled until `BE-018` exposes public/admin-manage scheduler contracts or returns explicit unsupported capability states.

## SDK integration details

- Use `AuroraClient` APIs and capability graph; no direct fetch/invoke in screen components.

## Tauri/native integration details

- No Tauri/native work is expected in this task. Native capabilities must be consumed through the SDK/native manifest produced by the relevant `TAURI-*`, `AND-*`, or `IOS-*` task.

## UI/UX implementation details

- Replace fixtures with SDK hooks/resources.
- Use tables/cards/drawers from mock reference.
- Every manage operation uses AdminAction controller; read-only operations use regular SDK calls.
- Include denied/empty/loading/degraded/service-unavailable states.

## Code references to inspect first

- Future production UI package/routes/components
- Reference mock component files listed below.

## Mock/component references

- `modules/ui-mock-reference/app/(cockpit)/tools/page.tsx`
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

<!-- MESH-PRODUCTION-GAP-ADDENDUM -->
## Mesh production gap addendum

Scheduler UI must include remote delegation semantics from `MESH-GAP-009`.

Additional requirements:

- Show local jobs, remote-delegated jobs owned by this node, and jobs running on a remote peer as distinct ownership states.
- Job create/edit must include target peer/provider selector when remote execution or remote tool use is selected.
- Display delegated permission context, approval policy for scheduled tool executions, next approval requirement, and audit receipt.
- Cancellation/listing must respect owner namespace and permission; UI must show denied/foreign namespace clearly.
