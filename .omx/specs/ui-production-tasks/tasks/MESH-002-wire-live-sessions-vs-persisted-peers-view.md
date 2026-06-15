# MESH-002 — Wire live sessions vs persisted peers view

## Execution metadata

- **Phase:** P9 — Mesh/WebRTC UI and route policy
- **Lane:** mesh
- **Depends on:** MESH-001, BE-014
- **Parallelizable with:** None
- **Coverage matrix rows:** admin.mesh.peers
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Production-wire mesh/P2P surface for `admin.mesh.peers`.

## User-visible outcome

UI separates active WebRTC sessions from Auth mesh peer records and device records.

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

- `components/aurora/mesh/mesh-view.tsx`
- `components/aurora/admin/devices-view.tsx`

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
