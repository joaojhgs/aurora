# MESH-003 — Wire route policy editor and route explain UI


<!-- UI-BRANCH-POLICY -->
## UI branch and sequencing policy

- **Target implementation branch:** `feat/ui-multi-platform-integration`.
- Do not start production UI implementation from these tasks until the mesh-gap sequence is complete through `MESH-GAP-011` and `MESH-GAP-012` has refreshed UI/SDK tasks against the finalized mesh contracts.
- The UI branch should be created from the accepted `feat/mesh-full-services-integrations` result, not from stale `main` or the old migration branch.
- UI tasks may only be used as planning/reference before that gate; production wiring waits for final capability catalog, route explain, aggregate tooling, approval protocol, data/RAG, audio, scheduler, audit, and diagnostics contracts.

## Execution metadata

- **Phase:** P9 — Mesh/WebRTC UI and route policy
- **Lane:** mesh
- **Depends on:** MESH-001, BE-013, SDK-012
- **Parallelizable with:** None
- **Coverage matrix rows:** mesh.route.policy
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Production-wire mesh/P2P surface for `mesh.route.policy`.

## User-visible outcome

Users/admins can define/explain peer fallback policy with privacy/trust/latency rules.

## Backend/API implementation details

- Consume existing/new backend only through SDK; keep unsupported backend features disabled with capability explanation.

## SDK integration details

- Use `AuroraClient` APIs and capability graph; no direct fetch/invoke in screen components.

## Tauri/native integration details

- No Tauri/native work is expected in this task. Native capabilities must be consumed through the SDK/native manifest produced by the relevant `TAURI-*`, `AND-*`, or `IOS-*` task.

## UI/UX implementation details

- Use SDK mesh transport and peer manifest APIs.
- Display trust, fingerprint, permissions, route quality, latency, compatibility, last seen, live connection status.
- Sensitive/admin-critical actions use AdminAction.

## Code references to inspect first

- Future production UI package/routes/components
- Reference mock component files listed below.

## Mock/component references

- `components/aurora/mesh/mesh-view.tsx` route preview
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

<!-- MESH-PRODUCTION-GAP-ADDENDUM -->
## Mesh production gap addendum

This surface is the operator UI for `MESH-GAP-002` and `MESH-GAP-003`.

Additional requirements:

- Expose generated mesh config fields, including `require_explicit_selector`, allow/deny peer lists, required capability tags, minimum version, trust tier, fallback policy, and safety-sensitive method/tool classes.
- Route explain UI must show the exact backend route decision: selected provider, rejected candidates, rejection reasons, stale/latency/capacity/auth/policy status, explicit selector requirement, fallback eligibility, and privacy class.
- Support dry-run route explain for assistant prompts, tool calls, DB/RAG queries, audio sessions, model runtime selection, scheduler jobs, and admin actions.
- Editing route policy uses AdminAction and records an audit receipt.
- Visual state must distinguish persisted peer, live session, stale manifest, denied by policy, unsupported capability, and transport-down.

Additional acceptance criteria:

- Missing explicit selector produces a human-readable repair path and does not render as generic failure.
- Route explain tests include duplicated local+remote tool, remote RAG namespace, remote STT session, and scheduler delegation.
