# BE-013 — Add peer capability manifest and mesh route explain contracts


<!-- UI-BRANCH-POLICY -->
## UI branch and sequencing policy

- **Target implementation branch:** `feat/ui-multi-platform-integration`.
- Do not start production UI implementation from these tasks until the mesh-gap sequence is complete through `MESH-GAP-011` and `MESH-GAP-012` has refreshed UI/SDK tasks against the finalized mesh contracts.
- The UI branch should be created from the accepted `feat/mesh-full-services-integrations` result, not from stale `main` or the old migration branch.
- UI tasks may only be used as planning/reference before that gate; production wiring waits for final capability catalog, route explain, aggregate tooling, approval protocol, data/RAG, audio, scheduler, audit, and diagnostics contracts.

## Execution metadata

- **Phase:** P2 — Backend contract and gateway/API gaps
- **Lane:** backend/mesh
- **Depends on:** BE-002, MESH-GAP-003
- **Parallelizable with:** SDK-010, MESH-003
- **Coverage matrix rows:** mesh.route.policy
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Close backend/API gap for `mesh.route.policy` so production UI can be honest and enforceable.

## User-visible outcome

Backend has a typed contract, route/exposure decision, permission model, audit/privacy behavior, and tests.

## Backend/API implementation details

- Persist/expose peer provided services, methods, permissions, latency, compatibility, trust state, route quality, fallback rules, and reason strings.

## SDK integration details

- Update SDK generated descriptors, executable capability catalog, and diagnostic graph projection after backend contract lands.
- Classify unavailable/internal-only behavior explicitly.

## Tauri/native integration details

- No Tauri/native work is expected in this task. Native capabilities must be consumed through the SDK/native manifest produced by the relevant `TAURI-*`, `AND-*`, or `IOS-*` task.

## UI/UX implementation details

- UI must remain disabled/degraded until this backend task is complete; never simulate mutation success in production.

## Code references to inspect first

- `app/services/gateway/mesh/peer_registry.py`
- `app/services/gateway/mesh/routing_table.py`
- `app/messaging/mesh_bus.py`
- `app/shared/contracts/models/gateway.py` (`MethodInfo`, `ServiceAnnouncement`, `GetRegistryResponse`)
- `app/services/gateway/route_generator.py` (`RouteGenerator._generate_path`, `_create_handler`, `_add_route_to_router`)
- `app/services/gateway/auth.py` (`GatewayAuth`, auth middleware, `create_scoped_auth_check`)
- `app/services/gateway/registry_aggregator.py` (process/thread registry aggregation)
- `app/shared/auth/permissions.py` (canonical PascalCase permission resolution)
- `app/shared/contracts/registry.py` (`@method_contract`, registry metadata)

## Mock/component references

- `modules/ui-mock-reference/lib/aurora/types.ts`
- `modules/ui-mock-reference/lib/aurora/data.ts`
- `modules/ui-mock-reference/components/aurora/status-badges.tsx`
- `modules/ui-mock-reference/components/aurora/capability-drawer.tsx`

## Data, permissions, and privacy contract

- Use typed topic constants in `app/shared/contracts/models/*` before service code.
- Use Pydantic/IOModel request/response models and `@method_contract` exposure/method_type metadata.

## Acceptance criteria

- New/changed topics use typed constants and registered contracts.
- Permission strings are PascalCase and method_type is passed to checks.
- OpenAPI/registry inventory reflects the new route or intentional internal-only state.
- Audit/privacy behavior is specified and tested.

## Verification commands / evidence

- Targeted unit tests under `tests/unit/gateway`, `tests/unit/services`, or service-specific folders.
- Integration test when contract crosses Gateway/Auth/Config/Mesh.
- `make lint` or targeted `ruff check` for touched Python files.

## Risks and guardrails

- Do not bypass bus communication.
- Do not use ConfigManager outside ConfigService/runtime-approved scripts.

## Handoff notes

- No additional handoff notes at planning time.

<!-- MESH-PRODUCTION-GAP-ADDENDUM -->
## Mesh production gap addendum

This task is superseded/expanded by `MESH-GAP-003`: implement a typed capability catalog, not only a peer manifest.

Additional backend requirements:

- Add or finalize typed models for `CapabilityCatalogRequest/Response`, `CapabilityProviderInfo`, `CapabilityActionInfo`, `CapabilityResourceInfo`, `CapabilityPolicyDecisionInfo`, `CapabilityFreshnessInfo`, `RouteExplainRequest/Response`, `RouteCandidateDecision`, and `RouteBlockerInfo`.
- Include local and remote providers in one catalog: services, methods, tools, model runtimes, data/RAG namespaces, audio devices/sessions, scheduler ownership, native platform capabilities, and diagnostics.
- Route explain must include selected provider, rejected candidates, reasons, explicit selector status, freshness, policy state, auth/RBAC state, transport, latency/capacity, and privacy class.
- Continue supporting existing `Gateway.GetCapabilityGraph` if present, but avoid naming collisions: graph can be derived/diagnostic, catalog is the executable SDK contract and must carry bindability/approval/selector state.
- Add fixtures that the UI SDK can ingest without importing Python internals.

Additional acceptance criteria:

- `SDK-006`, `SDK-012`, `MESH-003`, `ADM-001`, and `QA-008` can be implemented against this contract without backend guesswork.
