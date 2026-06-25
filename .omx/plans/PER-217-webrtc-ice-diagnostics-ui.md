# PER-217 / MESH-004 WebRTC ICE Diagnostics UI Plan

## Requirements Summary

- Add a production diagnostics surface for `mesh.diagnostics` on branch `multica/MESH-004-webrtc-ice-diagnostics-ui`.
- Use `AuroraClient` only; screen components must not call `fetch`, Tauri IPC, raw WebRTC APIs, or backend service objects.
- Use backend evidence from `client.registry.getWebRTCDiagnostics()`, `client.mesh.getStatus()`, and `client.capabilities.listCatalog()`.
- Render signaling, ICE, auth, DataChannel, RTT, route quality, trust/fingerprint/permission/compatibility/last-seen, redaction, denied/degraded/unavailable, and SDK error states.
- Keep unsupported features visible with capability explanations. Do not ship fixture-only claims as production truth.
- Keep Tauri-readiness by exporting reusable `@aurora/ui` components that receive an `AuroraClient`.

## Implementation Steps

1. Add `packages/aurora-ui/src/mesh-diagnostics-view.tsx` with:
   - `MeshDiagnosticsResource` client loader.
   - `buildMeshDiagnosticsSnapshot(client, route)` pure builder.
   - `MeshDiagnosticsView` render-only component for route, signaling, peer transport, compatibility, and recent errors.
2. Export the component and builder from `packages/aurora-ui/src/index.ts`.
3. Wire `apps/aurora-web/app/diagnostics/page.tsx` to render the reusable mesh diagnostics view using the existing SDK-backed diagnostics inputs.
4. Add focused component tests in `packages/aurora-ui/tests/shell.test.tsx` for happy, degraded/denied/unavailable, empty, and SDK error states.
5. Run targeted verification:
   - `pnpm --filter @aurora/ui typecheck`
   - `pnpm --filter @aurora/ui test`
   - `pnpm --filter aurora-web test`
   - `pnpm --filter aurora-web build`

## UX Flow

- Load diagnostics through SDK and show `pending` until responses settle.
- Present top-level runtime state and redaction evidence.
- Show signaling setup separately from peer transport rows so room/broker/app-layer E2EE failures are visible without inspecting peer rows.
- For each live peer, show stable peer ID, signaling peer ID, auth state, ICE state, DataChannel state, RTT, permissions, route quality, manifest freshness, compatibility, and last seen/ping age.
- Put detailed error codes and correlation-style identifiers in tables/details rather than permanent headline copy.

## Accessibility And Focus

- Use semantic sections, tables, headings, labels, and `aria-live`/`role="alert"` for loading and failure states.
- Keep details disclosure keyboard native; focus stays on the activating summary.
- Avoid icon-only action buttons; diagnostics are read-only except existing support export AdminAction.

## Acceptance Criteria

- Responsive layout works through existing `@aurora/ui` CSS grid patterns for desktop, tablet, and mobile.
- Feature visibility and disabled states are driven by route/capability/backend diagnostics, not hardcoded success.
- Admin-critical support bundle export remains handled by the existing AdminAction control.
- Tests cover connected, degraded/denied/unavailable, empty, and SDK error states.

## Risks And Mitigations

- Risk: duplicate diagnostics logic between the web page and UI package. Mitigation: move mesh-specific normalization into `@aurora/ui` and reuse it from the web route.
- Risk: backend fields vary by deployment. Mitigation: null-safe normalization, unsupported/degraded copy, and raw IDs preserved in rows.
- Risk: overclaiming Tauri/native proof. Mitigation: no Tauri E2E claim; reusable UI remains SDK-bound and Tauri-ready.
