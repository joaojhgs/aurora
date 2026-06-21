# SDK-006 — Implement capability graph engine


<!-- UI-BRANCH-POLICY -->
## UI branch and sequencing policy

- **Target implementation branch:** `feat/ui-multi-platform-integration`.
- Do not start production UI implementation from these tasks until the mesh-gap sequence is complete through `MESH-GAP-011` and `MESH-GAP-012` has refreshed UI/SDK tasks against the finalized mesh contracts.
- The UI branch should be created from the accepted `feat/mesh-full-services-integrations` result, not from stale `main` or the old migration branch.
- UI tasks may only be used as planning/reference before that gate; production wiring waits for final capability catalog, route explain, aggregate tooling, approval protocol, data/RAG, audio, scheduler, audit, and diagnostics contracts.

## Execution metadata

- **Phase:** P1 — Transport-independent SDK and capability graph foundation
- **Lane:** sdk
- **Depends on:** SDK-001, SDK-002, SDK-004, SDK-005, MESH-GAP-003, MESH-GAP-004, MESH-GAP-005
- **Parallelizable with:** None
- **Coverage matrix rows:** sdk.transport.client, gateway.method_exposure_matrix
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Merge registry, identity, transport, native capability, peer manifests, privacy policy, and service health into feature states.

## User-visible outcome

Navigation and every surface render available/degraded/blocked states from one engine.

## Backend/API implementation details

- Consume `Gateway.GetRegistry`/OpenAPI and gateway built-ins; do not invent method IDs.
- Treat internal-only methods as unavailable for HTTP unless local/Tauri transport explicitly supports bus access.

## SDK integration details

- Export `AuroraClient`, transport interfaces, generated method descriptors, executable capability catalog/graph projections, auth/session helpers, and test utilities.
- Use strict TypeScript and no React dependency in the core package.

## Tauri/native integration details

- No Tauri/native work is expected in this task. Native capabilities must be consumed through the SDK/native manifest produced by the relevant `TAURI-*`, `AND-*`, or `IOS-*` task.

## UI/UX implementation details

- All production UI tasks must use this SDK surface rather than direct `fetch`, `invoke`, diagnostic graph-only data, or fixture imports.

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

This task is now downstream of `.omx/multica/mesh-production-gap-tasks/03-mesh-gap-003-mesh-gap-p1-define-typed-capability-catalog-and-route-explain-backend-contracts.md` and must treat the mesh capability catalog as a first-class source, not as a diagnostics-only graph.

Additional requirements:

- Expose the capability catalog through `client.capabilities.listCatalog(options)` over `Gateway.GetCapabilityCatalog`, preserving raw action/provider IDs, selector fields, bindability, policy flags, freshness, blockers, and `secrets_redacted`.
- Expose aggregate tool inventory through `client.tools.listCatalog(options)` over `Tooling.GetToolCatalog`, returning bindable tools and approval/blocked candidates as separate collections rather than dropping blocked capabilities.
- Add `client.capabilities.explain(featureId)` as an SDK projection over the cached catalog node plus the latest provider/route blockers; it must include the next backend-backed repair action when available.
- Consume the backend typed capability catalog once `Gateway.GetCapabilityCatalog` / equivalent lands, including local node, remote peer, transport, service, method, tool, model, audio, scheduler, and data/RAG capabilities.
- Merge capability facts from local HTTP Gateway, Tauri native manifest, mobile native manifest, persisted peers, live WebRTC sessions, and policy results into one deterministic feature-state graph.
- Preserve provider identity in feature states: `local`, `remote:<peer_id>`, `native:<platform>`, `cloud`, `unavailable`, and `blocked` must be distinguishable.
- Include freshness, trust tier, routeability, selected provider, alternate providers, disabled reason, and required user/admin action in graph nodes.
- Represent aggregate tool inventory as local-plus-remote candidates. The graph must not collapse multiple providers of the same tool into one anonymous capability.
- Surface explicit selector requirements from `MESH-GAP-002`; safety-sensitive features must show "choose a peer/provider" rather than silently fallback.
- Include approval policy capabilities from `MESH-GAP-005`: internal/local tools and mesh tools can both require approval; approval modes include deny-all, ask-each-time, allow-once, allow-until-expiry, approve-all-for-session, approve-all-for-trusted-peer, approve-all-local-safe, and dry-run-only.
- Unit fixtures must include at least one local-only tool, one remote-only tool, one duplicated local+remote tool, one disabled-by-policy remote tool, one stale peer capability, and one native-mobile-only capability.

Additional acceptance criteria:

- UI tasks can ask `AuroraClient.capabilities.explain(featureId)` and receive a stable explanation with provider candidates and next repair action.
- Capability graph tests prove that local and remote tool providers coexist and remain separately selectable.
- Capability graph tests prove explicit selector policy blocks unsafe fallback.
- Diagnostic `Gateway.GetCapabilityGraph` fixtures, if present, cannot mark actions executable unless the `Gateway.GetCapabilityCatalog` fixture also marks them bindable or approval-required with a backend repair path.
- SDK fixtures include `Tooling.GetToolCatalog` responses with `blocked_tools` for approval-required local and remote tools, and graph tests prove those become approval-card candidates rather than bindable model tools.
