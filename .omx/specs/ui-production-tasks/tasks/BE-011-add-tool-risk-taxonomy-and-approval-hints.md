# BE-011 — Add tool risk taxonomy and approval hints


<!-- UI-BRANCH-POLICY -->
## UI branch and sequencing policy

- **Target implementation branch:** `feat/ui-multi-platform-integration`.
- Do not start production UI implementation from these tasks until the mesh-gap sequence is complete through `MESH-GAP-011` and `MESH-GAP-012` has refreshed UI/SDK tasks against the finalized mesh contracts.
- The UI branch should be created from the accepted `feat/mesh-full-services-integrations` result, not from stale `main` or the old migration branch.
- UI tasks may only be used as planning/reference before that gate; production wiring waits for final capability catalog, route explain, aggregate tooling, approval protocol, data/RAG, audio, scheduler, audit, and diagnostics contracts.

## Execution metadata

- **Phase:** P2 — Backend contract and gateway/API gaps
- **Lane:** backend/tools
- **Depends on:** P0-002, MESH-GAP-005
- **Parallelizable with:** UIA-003, ADM-007
- **Coverage matrix rows:** assistant.tool.approval
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Close backend/API gap for `assistant.tool.approval` so production UI can be honest and enforceable.

## User-visible outcome

Backend has a typed contract, route/exposure decision, permission model, audit/privacy behavior, and tests.

## Backend/API implementation details

- Attach risk class, data egress, mutating/external/admin flags, required approval, and privacy hints to tools.
- Tool execution audit should include approved/denied decision metadata.

## SDK integration details

- Update SDK generated descriptors and capability graph after backend contract lands.
- Classify unavailable/internal-only behavior explicitly.

## Tauri/native integration details

- No Tauri/native work is expected in this task. Native capabilities must be consumed through the SDK/native manifest produced by the relevant `TAURI-*`, `AND-*`, or `IOS-*` task.

## UI/UX implementation details

- UI must remain disabled/degraded until this backend task is complete; never simulate mutation success in production.

## Code references to inspect first

- `app/services/tooling/service.py` legacy `GetTools`/`ExecuteTool` serialization; do not treat `GetTools` as the full mesh catalog.
- `app/services/tooling/tools/` core tools
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

This task should be treated as part of `MESH-GAP-005`, not merely a display-hint task.

Additional backend requirements:

- Define canonical tool risk and sharing-policy models for local/internal tools and mesh-exposed tools.
- Add or consume `Tooling.GetToolCatalog`, `Tooling.GetSharingPolicy`, `Tooling.SetSharingPolicy`, `Tooling.TestSharingPolicy`, `Tooling.PrepareExecution`, `Tooling.RequestApproval`, and `Tooling.ConfirmExecution` contracts from `MESH-GAP-004`/`MESH-GAP-005`.
- Add config schema/defaults for per-service, per-toolkit, per-tool, and per-peer sharing policy.
- Add approval request/decision/receipt models with nonce/token binding to tool id, provider selector, args hash, risk class, approval scope, expiry, and principal.
- Add configurable approval modes: deny_all, ask_each_time, allow_once, allow_until_expiry, approve_all_for_session, approve_all_for_trusted_peer, approve_all_local_safe, and dry_run_only.
- Enforce policy in `Tooling.ExecuteTool` or the shared execution wrapper before local and remote execution; do not rely on UI-only approval.
- Emit audit events for requested, approved, denied, expired, replay rejected, dry-run, and executed.

Additional acceptance criteria:

- Internal/local tools can require approval and are covered by the same tests as remote mesh tools.
- `Tooling.GetTools` remains backward-compatible/per-provider only; aggregate UI/SDK discovery must use `Tooling.GetToolCatalog` or `Gateway.GetCapabilityCatalog`.
- Approval replay, changed args, changed peer/provider, expired TTL, and missing explicit selector fail closed.
