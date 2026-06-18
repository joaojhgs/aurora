# UIA-006 — Wire conversation history, memory, and RAG provenance UI


<!-- UI-BRANCH-POLICY -->
## UI branch and sequencing policy

- **Target implementation branch:** `feat/ui-multi-platform-integration`.
- Do not start production UI implementation from these tasks until the mesh-gap sequence is complete through `MESH-GAP-011` and `MESH-GAP-012` has refreshed UI/SDK tasks against the finalized mesh contracts.
- The UI branch should be created from the accepted `feat/mesh-full-services-integrations` result, not from stale `main` or the old migration branch.
- UI tasks may only be used as planning/reference before that gate; production wiring waits for final capability catalog, route explain, aggregate tooling, approval protocol, data/RAG, audio, scheduler, audit, and diagnostics contracts.

## Execution metadata

- **Phase:** P7 — Assistant UI production wiring
- **Lane:** assistant-memory
- **Depends on:** UIA-001, SDK-007, BE-017
- **Parallelizable with:** None
- **Coverage matrix rows:** assistant.history
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Expose history and memory without leaking sensitive data or overclaiming mobile local storage.

## User-visible outcome

User can browse/search conversations, inspect memory/RAG provenance, delete/export where backend supports it.

## Backend/API implementation details

- Consume existing/new backend only through SDK; keep unsupported backend features disabled with capability explanation.

## SDK integration details

- Use `AuroraClient` APIs and capability graph; no direct fetch/invoke in screen components.

## Tauri/native integration details

- No Tauri/native work is expected in this task. Native capabilities must be consumed through the SDK/native manifest produced by the relevant `TAURI-*`, `AND-*`, or `IOS-*` task.

## UI/UX implementation details

- Read history via DB/RAG SDK methods.
- Show privacy class/source/citations.
- Gate delete/export behind backend support/AdminAction as needed.

## Code references to inspect first

- Future production UI package/routes/components
- Reference mock component files listed below.

## Mock/component references

- `modules/ui-mock-reference/app/(cockpit)/memory/page.tsx`
- `lib/aurora/types.ts` Conversation/ChatMessage

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

This UI must represent remote RAG/data namespaces from `MESH-GAP-007`.

Additional requirements:

- Add namespace selector/filter for local memory, local RAG, remote peer namespaces, imported snapshots, and unavailable/stale namespaces.
- Search results must show provenance: peer/provider, namespace, privacy class, route path, source/citation, redaction status, and audit/correlation ID.
- Delete/export/import actions require AdminAction or data-sharing approval according to backend policy.
- Explicit selector missing, remote namespace denied, incompatible embeddings, stale peer, and policy-blocked states need first-class UI copy.

Additional acceptance criteria:

- UI never labels remote results as local memory.
- Tests cover remote namespace search, export approval, import preview, denied namespace, and provenance display.
