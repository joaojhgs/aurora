# ADM-013 — Wire deployment topology and process-mode operations dashboard


<!-- UI-BRANCH-POLICY -->
## UI branch and sequencing policy

- **Target implementation branch:** `feat/ui-multi-platform-integration`.
- Do not start production UI implementation from these tasks until the mesh-gap sequence is complete through `MESH-GAP-011` and `MESH-GAP-012` has refreshed UI/SDK tasks against the finalized mesh contracts.
- The UI branch should be created from the accepted `feat/mesh-full-services-integrations` result, not from stale `main` or the old migration branch.
- UI tasks may only be used as planning/reference before that gate; production wiring waits for final capability catalog, route explain, aggregate tooling, approval protocol, data/RAG, audio, scheduler, audit, and diagnostics contracts.

## Execution metadata

- **Phase:** P8 — Admin/operator dashboard production wiring
- **Lane:** admin
- **Depends on:** ADM-001, BE-016, SDK-006
- **Parallelizable with:** MESH-002, ADM-009
- **Coverage matrix rows:** admin.deployment_topology, runtime.mode_matrix
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Add the admin/operator UI surface that explains how Aurora is deployed and which runtime/transport infrastructure is healthy.

## User-visible outcome

Operators can see at a glance whether they are managing a server process-mode deployment, local thread-mode app, desktop sidecar, or mesh peer shell, and what infrastructure is degraded.

## Backend/API implementation details

- Consume `BE-016` only; do not shell out to Docker/Tilt from the browser.
- Link service-control buttons to `BE-015` and diagnostics export to `BE-005`; keep controls disabled if unsupported.

## SDK integration details

- Use `AuroraClient.getDeploymentTopology()` / generated method descriptor and capability graph degraded reasons.
- Route all topology refresh, diagnostics, and service links through SDK permissions and AdminAction where mutating.

## Tauri/native integration details

- Desktop local mode combines sidecar status with backend topology through SDK.
- Thin web/mobile mode displays remote server topology only when the authenticated principal has permission.

## UI/UX implementation details

- Add cards/sections for architecture mode, bus backend, Redis/BullMQ health, service registry freshness, container/process hints, active transport, and degraded mode explanations.
- Provide operator links to diagnostics, services/contracts, config reload impact, and runbooks.
- Display clear read-only state for thread mode/no process controls and mobile thin/mesh clients.

## Code references to inspect first

- `.omx/specs/ui-production-tasks/tasks/BE-016-add-deployment-topology-bus-health-and-process-mode-contract.md`
- `README.process-mode.md`
- `docs/TILT.md`
- `docker-compose.process.yml`
- `modules/ui-mock-reference/app/(cockpit)/admin/page.tsx`
- `modules/ui-mock-reference/components/aurora/admin/overview.tsx`

## Mock/component references

- `modules/ui-mock-reference/components/aurora/app-shell.tsx`
- `modules/ui-mock-reference/components/aurora/admin/overview.tsx`
- `modules/ui-mock-reference/components/aurora/admin/services-view.tsx`
- `modules/ui-mock-reference/components/aurora/status-badges.tsx`

## Data, permissions, and privacy contract

- Use typed topic constants and registered method contracts for any backend additions.
- Sanitize deployment topology, peer topology, Redis URLs, tokens, local filesystem paths, and diagnostics before exposing them to UI.
- Use capability graph and AdminAction for any mutation or privileged detail; read-only degraded states still require permission checks when topology could leak sensitive infrastructure.

## Acceptance criteria

- Dashboard distinguishes thread mode, process mode, desktop local sidecar, server thin, and mesh peer-only shell.
- Redis/BullMQ degraded states have actionable copy and diagnostic links.
- No unsupported process restart/control button is enabled without `BE-015` capability.

## Verification commands / evidence

- Playwright/admin component tests over capability fixtures for thread/process/redis-down/mesh-only modes.
- Visual regression against mock references.
- Manual process-mode smoke against Docker Compose or documented skip with evidence.

## Risks and guardrails

- Do not bypass the bus or SDK boundaries to make UI state easier.
- Do not leak Redis URLs, host paths, peer secrets, tokens, or private model paths.
- Do not treat mock transport, emulator-only, or single-mode smoke as production parity.

## Handoff notes

- Added by full coverage review to make previously implicit process-mode, deployment-topology, and legacy UI migration coverage explicit.
