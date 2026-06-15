# BE-001 — Normalize auth/gateway route casing and public bypass behavior

## Execution metadata

- **Phase:** P2 — Backend contract and gateway/API gaps
- **Lane:** backend/gateway
- **Depends on:** P0-002
- **Parallelizable with:** SDK-004, UI-003
- **Coverage matrix rows:** auth.session.state_machine
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Close backend/API gap for `auth.session.state_machine` so production UI can be honest and enforceable.

## User-visible outcome

Backend has a typed contract, route/exposure decision, permission model, audit/privacy behavior, and tests.

## Backend/API implementation details

- Smoke-test and fix if needed mismatch between lowercase bypass paths (`/api/auth/login`) and generated PascalCase routes (`/api/Auth/Login`).
- Ensure bypass returns ANONYMOUS, not SYSTEM, except auth disabled mode.
- Document canonical public auth endpoints for SDK.

## SDK integration details

- Update SDK generated descriptors and capability graph after backend contract lands.
- Classify unavailable/internal-only behavior explicitly.

## Tauri/native integration details

- No Tauri/native work is expected in this task. Native capabilities must be consumed through the SDK/native manifest produced by the relevant `TAURI-*`, `AND-*`, or `IOS-*` task.

## UI/UX implementation details

- UI must remain disabled/degraded until this backend task is complete; never simulate mutation success in production.

## Code references to inspect first

- `app/services/gateway/auth.py` bypass paths
- `app/services/gateway/route_generator.py` dynamic `/api/{module}/{method}` paths
- `app/services/auth/service.py` Auth.Login/Pairing contracts
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
