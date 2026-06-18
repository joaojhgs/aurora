# ADM-007 — Wire plugins, MCP, tools and reload/install states


<!-- UI-BRANCH-POLICY -->
## UI branch and sequencing policy

- **Target implementation branch:** `feat/ui-multi-platform-integration`.
- Do not start production UI implementation from these tasks until the mesh-gap sequence is complete through `MESH-GAP-011` and `MESH-GAP-012` has refreshed UI/SDK tasks against the finalized mesh contracts.
- The UI branch should be created from the accepted `feat/mesh-full-services-integrations` result, not from stale `main` or the old migration branch.
- UI tasks may only be used as planning/reference before that gate; production wiring waits for final capability catalog, route explain, aggregate tooling, approval protocol, data/RAG, audio, scheduler, audit, and diagnostics contracts.

## Execution metadata

- **Phase:** P8 — Admin/operator dashboard production wiring
- **Lane:** admin
- **Depends on:** SDK-007, BE-011
- **Parallelizable with:** None
- **Coverage matrix rows:** admin.plugins
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Production-wire admin surface for `admin.plugins`.

## User-visible outcome

Show plugin/MCP status, safe config toggles, internal-only reload, tool inventory and risk metadata.

## Backend/API implementation details

- Consume existing/new backend only through SDK; keep unsupported backend features disabled with capability explanation.

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

- `components/aurora/admin/secondary-surface.tsx` PluginsPanel
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

<!-- MESH-PRODUCTION-GAP-ADDENDUM -->
## Mesh production gap addendum

This admin surface must manage the policy side of aggregate local+remote tools once `MESH-GAP-004` and `MESH-GAP-005` land.

Additional requirements:

- Display tool inventory grouped by provider: local built-in, local plugin, local MCP, remote peer built-in, remote peer plugin/MCP, and unavailable/stale provider.
- Add policy controls for share none, share all tools in a service/toolkit, share selected tools only, deny selected tools, require confirmation, dry-run-only, and allowed peer/provider lists.
- Show per-tool risk metadata, data classes, admin/mutating/external flags, approval mode, default TTL, and last audit outcome.
- Plugin/MCP reload/install actions remain AdminAction-gated; tool sharing policy changes are AdminAction-gated and audited.
- Remote peer tool policy must be read-only unless the current node owns the policy being edited.

Additional acceptance criteria:

- Admin can configure approval policy for internal/local tools, not only mesh tools.
- UI clearly distinguishes "tool installed locally" from "tool discoverable from peer" and "tool shared to peers".
