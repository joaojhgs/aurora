# ADM-009 — Wire diagnostics probes and redacted support bundle


<!-- UI-BRANCH-POLICY -->
## UI branch and sequencing policy

- **Target implementation branch:** `feat/ui-multi-platform-integration`.
- Do not start production UI implementation from these tasks until the mesh-gap sequence is complete through `MESH-GAP-011` and `MESH-GAP-012` has refreshed UI/SDK tasks against the finalized mesh contracts.
- The UI branch should be created from the accepted `feat/mesh-full-services-integrations` result, not from stale `main` or the old migration branch.
- UI tasks may only be used as planning/reference before that gate; production wiring waits for final capability catalog, route explain, aggregate tooling, approval protocol, data/RAG, audio, scheduler, audit, and diagnostics contracts.

## Execution metadata

- **Phase:** P8 — Admin/operator dashboard production wiring
- **Lane:** admin
- **Depends on:** SDK-013, BE-005, MESH-GAP-010
- **Parallelizable with:** None
- **Coverage matrix rows:** admin.diagnostics.export
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Production-wire admin surface for `admin.diagnostics.export`.

## User-visible outcome

Show probes, native/sidecar/gateway/mesh logs, redaction preview, export bundle with audit receipt.

## Backend/API implementation details

- Consume existing/new backend only through SDK; keep unsupported backend features disabled with capability explanation.

## SDK integration details

- Use `AuroraClient` APIs and executable capability catalog projections; no direct fetch/invoke or diagnostic graph-only execution in screen components.

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

- `components/aurora/diagnostics/diagnostics-view.tsx`

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

Diagnostics must include `MESH-GAP-010` artifacts.

Additional requirements:

- Include mesh route explain snapshots, capability catalog snapshot, peer/session status, WebRTC/ICE/data-channel diagnostics, approval policy state, audit correlation summary, and config parity checks.
- Redaction preview must cover tokens, peer secrets, Redis URLs, host paths, model paths, tool args, RAG content, and audio/session metadata.
- Support bundle generation remains AdminAction-gated and must produce an audit receipt.
