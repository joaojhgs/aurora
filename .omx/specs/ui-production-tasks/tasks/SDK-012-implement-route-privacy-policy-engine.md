# SDK-012 — Implement route/privacy policy engine


<!-- UI-BRANCH-POLICY -->
## UI branch and sequencing policy

- **Target implementation branch:** `feat/ui-multi-platform-integration`.
- Do not start production UI implementation from these tasks until the mesh-gap sequence is complete through `MESH-GAP-011` and `MESH-GAP-012` has refreshed UI/SDK tasks against the finalized mesh contracts.
- The UI branch should be created from the accepted `feat/mesh-full-services-integrations` result, not from stale `main` or the old migration branch.
- UI tasks may only be used as planning/reference before that gate; production wiring waits for final capability catalog, route explain, aggregate tooling, approval protocol, data/RAG, audio, scheduler, audit, and diagnostics contracts.

## Execution metadata

- **Phase:** P1 — Transport-independent SDK and capability graph foundation
- **Lane:** sdk
- **Depends on:** SDK-001
- **Parallelizable with:** None
- **Coverage matrix rows:** sdk.transport.client, gateway.method_exposure_matrix
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Classify payload privacy, compare route candidates, block unsafe peer/cloud fallback, and produce redacted preview.

## User-visible outcome

RouteSheet and tool approvals show why a route is allowed or blocked.

## Backend/API implementation details

- Consume `Gateway.GetRegistry`/OpenAPI and gateway built-ins; do not invent method IDs.
- Treat internal-only methods as unavailable for HTTP unless local/Tauri transport explicitly supports bus access.

## SDK integration details

- Export `AuroraClient`, transport interfaces, generated method descriptors, capability graph, auth/session helpers, and test utilities.
- Use strict TypeScript and no React dependency in the core package.

## Tauri/native integration details

- No Tauri/native work is expected in this task. Native capabilities must be consumed through the SDK/native manifest produced by the relevant `TAURI-*`, `AND-*`, or `IOS-*` task.

## UI/UX implementation details

- All production UI tasks must use this SDK surface rather than direct `fetch`, `invoke`, or fixture imports.

## Code references to inspect first

- `app/shared/contracts/models/gateway.py` (`MethodInfo`, `ServiceAnnouncement`, `GetRegistryResponse`)
- `app/services/gateway/route_generator.py` (`RouteGenerator._generate_path`, `_create_handler`, `_add_route_to_router`)
- `app/services/gateway/auth.py` (`GatewayAuth`, auth middleware, `create_scoped_auth_check`)
- `app/services/gateway/registry_aggregator.py` (process/thread registry aggregation)
- `app/shared/auth/permissions.py` (canonical PascalCase permission resolution)
- `app/shared/contracts/registry.py` (`@method_contract`, registry metadata)
- `.omx/specs/ui-refinement/aurora-ui-sdk-contract.md`

## Mock/component references

- `modules/ui-mock-reference/lib/aurora/types.ts`
- `modules/ui-mock-reference/lib/aurora/data.ts`
- `modules/ui-mock-reference/components/aurora/status-badges.tsx`
- `modules/ui-mock-reference/components/aurora/capability-drawer.tsx`
- `modules/ui-mock-reference/components/aurora/assistant/route-sheet.tsx` for route/privacy behavior
- `modules/ui-mock-reference/components/aurora/admin-confirm-dialog.tsx` for admin action behavior

## Data, permissions, and privacy contract

- Privacy classes and availability states must match mock/spec enums.
- Method identity is `bus_topic` + method name; current `MethodInfo` has no `id` field.

## Acceptance criteria

- Public API documented with examples for HTTP, Tauri local, mesh, native mobile, and mock.
- Errors classify auth, permission, validation, timeout, unavailable service, unsupported feature, privacy blocked, and native permission missing.
- Unit tests cover success/failure/permission/transport-loss paths.

## Verification commands / evidence

- `pnpm --filter @aurora/client typecheck`
- `pnpm --filter @aurora/client test`
- Contract fixture comparison against generated backend inventory.

## Risks and guardrails

- Do not couple SDK to Next.js, Tauri, or React.
- Do not lowercase backend permission IDs.

## Handoff notes

- No additional handoff notes at planning time.

<!-- MESH-PRODUCTION-GAP-ADDENDUM -->
## Mesh production gap addendum

This task is now downstream of `MESH-GAP-002`, `MESH-GAP-003`, and `MESH-GAP-005`. It must make routing/privacy decisions for all provider types: local process/thread, HTTP server, Tauri native/local node, mesh peer, mobile native, and cloud fallback.

Additional requirements:

- Consume route explain output (`Gateway.ExplainRoute` / equivalent) rather than independently guessing backend routing decisions.
- Model explicit resource selectors as required for tools, DB/RAG namespaces, audio/STT/TTS sessions, scheduler ownership, hardware/device access, model runtime selection, and admin mutations when policy marks them safety-sensitive.
- Treat internal/local tools and remote mesh tools uniformly through the approval policy engine: both can require user approval, admin confirmation, dry-run preview, deny, or approve-all scope.
- Add approval scope evaluation for: single execution, tool+args hash, peer/provider, session, local-safe tools, expiry window, and deny-all/default-block.
- Generate redacted route previews that include provider, peer trust tier, data classes, egress destination, transport, expected persistence, and audit receipt target.
- Never downgrade a policy denial into a generic unavailable state. UI needs the denial reason and repair path.

Additional acceptance criteria:

- `RouteSheet` and approval cards can show exact backend route decisions, not duplicated SDK guesses.
- Tests cover local dangerous tool approval, remote dangerous tool approval, approve-all session behavior, expired approvals, route denial, replay/mismatched args rejection, and explicit selector missing errors.
