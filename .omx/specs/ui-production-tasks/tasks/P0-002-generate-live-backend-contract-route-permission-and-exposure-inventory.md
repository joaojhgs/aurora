# P0-002 — Generate live backend contract, route, permission, and exposure inventory

## Execution metadata

- **Phase:** P0 — Production planning baseline and repository readiness
- **Lane:** backend/readiness
- **Depends on:** None
- **Parallelizable with:** P0-001, P0-003
- **Coverage matrix rows:** gateway.method_exposure_matrix, auth.session.state_machine
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Build a repeatable inventory command/test that exports current MethodInfo, OpenAPI paths, permissions, exposure, method_type, and gateway built-ins.

## User-visible outcome

The SDK/UI work starts from machine-readable backend truth, not stale fixture data.

## Backend/API implementation details

- Add or document a non-mutating script/test that boots enough registry context to emit JSON inventory.
- Classify dynamic routes (`/api/{Module}/{Method}`) separately from gateway built-ins (`/api/health`, `/api/registry`, `/api/services`, `/api/routes`, admin connected peers if present).
- Smoke-test auth bypass path casing for `Auth.Login` and pairing routes because current bypass examples are lowercase while generated routes are PascalCase.

## SDK integration details

- No new SDK surface is expected in this task. Consume existing SDK APIs only, and add SDK work to the relevant `SDK-*` task if a gap is discovered.

## Tauri/native integration details

- No Tauri/native work is expected in this task. Native capabilities must be consumed through the SDK/native manifest produced by the relevant `TAURI-*`, `AND-*`, or `IOS-*` task.

## UI/UX implementation details

- No production UI changes are expected in this task. Any UI impact should be documented as downstream work and linked to the relevant `UI-*`, `UIA-*`, `ADM-*`, or `MESH-*` task.

## Code references to inspect first

- `app/shared/contracts/models/gateway.py` (`MethodInfo`, `ServiceAnnouncement`, `GetRegistryResponse`)
- `app/services/gateway/route_generator.py` (`RouteGenerator._generate_path`, `_create_handler`, `_add_route_to_router`)
- `app/services/gateway/auth.py` (`GatewayAuth`, auth middleware, `create_scoped_auth_check`)
- `app/services/gateway/registry_aggregator.py` (process/thread registry aggregation)
- `app/shared/auth/permissions.py` (canonical PascalCase permission resolution)
- `app/shared/contracts/registry.py` (`@method_contract`, registry metadata)
- `app/shared/contracts/models/auth.py` (`AuthMethods`)
- `app/services/auth/service.py` method contracts, currently some literal method_id strings
- `tests/unit/gateway/` and `tests/integration/test_auth_*.py`

## Mock/component references

- `modules/ui-mock-reference/lib/aurora/data.ts` service/method fixtures should later be generated from this inventory.

## Data, permissions, and privacy contract

- Preserve the global privacy taxonomy and permission rules from the task index. If the task handles credentials, raw audio, personal data, admin-critical actions, or peer routing, classify it explicitly before implementation.

## Acceptance criteria

- JSON inventory includes module, method name, bus_topic, routePath, exposure, method_type, required_perms, input/output model names, schemas, and source file.
- Fails CI if a public UI fixture references a missing method/route without marking it planned/internal_only.
- Smoke test documents whether `/api/Auth/Login` or lowercase bypass routes are authoritative and aligns gateway bypass accordingly.

## Verification commands / evidence

- `pytest tests/unit/gateway -q` for route/auth inventory tests.
- Run inventory script and compare a sample against `Gateway.GetRegistry`/OpenAPI.

## Risks and guardrails

- Keep changes scoped to this task. Do not alter unrelated services, package layout, route semantics, permissions, or mock fixtures without a linked dependency update.

## Handoff notes

- No additional handoff notes at planning time.
