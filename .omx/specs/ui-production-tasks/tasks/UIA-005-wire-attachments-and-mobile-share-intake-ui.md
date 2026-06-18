# UIA-005 — Wire attachments and mobile share-intake UI


<!-- UI-BRANCH-POLICY -->
## UI branch and sequencing policy

- **Target implementation branch:** `feat/ui-multi-platform-integration`.
- Do not start production UI implementation from these tasks until the mesh-gap sequence is complete through `MESH-GAP-011` and `MESH-GAP-012` has refreshed UI/SDK tasks against the finalized mesh contracts.
- The UI branch should be created from the accepted `feat/mesh-full-services-integrations` result, not from stale `main` or the old migration branch.
- UI tasks may only be used as planning/reference before that gate; production wiring waits for final capability catalog, route explain, aggregate tooling, approval protocol, data/RAG, audio, scheduler, audit, and diagnostics contracts.

## Execution metadata

- **Phase:** P7 — Assistant UI production wiring
- **Lane:** assistant-context
- **Depends on:** UIA-001, BE-008, SDK-006
- **Parallelizable with:** AND-006, IOS-004
- **Coverage matrix rows:** assistant.attachments
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Implement context intake for files, URLs, images, screenshots, shared content, and privacy labels.

## User-visible outcome

User can attach/share context and see route/privacy restrictions before sending.

## Backend/API implementation details

- Consume existing/new backend only through SDK; keep unsupported backend features disabled with capability explanation.

## SDK integration details

- Use `AuroraClient` APIs and capability graph; no direct fetch/invoke in screen components.

## Tauri/native integration details

- No Tauri/native work is expected in this task. Native capabilities must be consumed through the SDK/native manifest produced by the relevant `TAURI-*`, `AND-*`, or `IOS-*` task.

## UI/UX implementation details

- Add attachment tray, upload/progress, classification, remove, error, unsupported type, share-source provenance.
- This UI task can implement generic attachment and share-intake rendering against SDK fixtures before Android/iOS native share plugins land; platform payload entrypoints remain capability-gated until `AND-006`/`IOS-004`.
- Use native share/deep-link payloads when app is opened through mobile system surfaces.

## Code references to inspect first

- Future production UI package/routes/components
- Reference mock component files listed below.

## Mock/component references

- `components/aurora/assistant/assistant-view.tsx` composer
- `components/aurora/assistant/route-sheet.tsx`
- `components/aurora/onboarding/onboarding-view.tsx`

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
