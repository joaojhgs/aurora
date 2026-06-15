# BE-005 — Add diagnostics bundle export contract with redaction

## Execution metadata

- **Phase:** P2 — Backend contract and gateway/API gaps
- **Lane:** backend/diagnostics
- **Depends on:** BE-004
- **Parallelizable with:** ADM-009
- **Coverage matrix rows:** admin.diagnostics.export
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Close backend/API gap for `admin.diagnostics.export` so production UI can be honest and enforceable.

## User-visible outcome

Backend has a typed contract, route/exposure decision, permission model, audit/privacy behavior, and tests.

## Backend/API implementation details

- Collect registry, service health, route state, config metadata, mesh status, recent audit metadata, native capability state, sidecar logs.
- Exclude secrets, tokens, raw audio, full personal transcripts unless explicitly included with admin-critical confirmation.

## SDK integration details

- Update SDK generated descriptors and capability graph after backend contract lands.
- Classify unavailable/internal-only behavior explicitly.

## Tauri/native integration details

- No Tauri/native work is expected in this task. Native capabilities must be consumed through the SDK/native manifest produced by the relevant `TAURI-*`, `AND-*`, or `IOS-*` task.

## UI/UX implementation details

- UI must remain disabled/degraded until this backend task is complete; never simulate mutation success in production.

## Code references to inspect first

- `app/helpers/aurora_logger.py`
- `app/services/gateway/registry_aggregator.py`
- `app/services/supervisor.py`
- `app/shared/auth/audit.py`
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
