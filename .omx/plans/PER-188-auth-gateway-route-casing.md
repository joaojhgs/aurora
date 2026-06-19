# PER-188 Plan: Auth/Gateway Route Casing and Public Bypass

## Requirements Summary

- Source issue: PER-188 / BE-001, `auth.session.state_machine`.
- Scope: normalize Auth/Gateway public route bypass behavior for generated PascalCase routes and lowercase legacy paths, without production UI wiring.
- Source docs read: root/service/gateway/auth/shared/contracts/tests `AGENTS.md`, `.omx/specs/ui-refinement/*`, `.omx/specs/ui-production-tasks/index.md`, `.omx/specs/ui-production-tasks/backend-gap-crosswalk.md`, `.omx/specs/mesh-ui-roadmap-integration-review.md`, and `docs/GATEWAY.md`.
- Code paths: `app/services/gateway/auth.py`, `app/services/gateway/route_generator.py`, `app/services/auth/service.py`, `app/shared/contracts/models/auth.py`, `docs/GATEWAY.md`, focused gateway tests.
- Invariant: `SYSTEM` is only for auth-disabled mode or validated API keys; auth-enabled public bypass paths resolve as `ANONYMOUS`.

## Acceptance Criteria

- Canonical generated public Auth endpoints `/api/Auth/Login`, `/api/Auth/PairingStart`, `/api/Auth/PairingConnect`, and `/api/Auth/PairingExchange` bypass authentication when auth is enabled.
- Lowercase legacy public Auth paths continue to bypass authentication where already supported.
- Bypassed auth-enabled requests resolve as `ANONYMOUS`, not `SYSTEM`, in both middleware and FastAPI security dependency paths.
- Protected generated Auth routes keep normal permission checks and do not become public through prefix matching.
- Auth contract decorators use typed `AuthMethods` constants for touched public methods.
- Gateway docs name canonical public Auth endpoints for SDK consumers.

## Implementation Steps

1. Add a canonical public Auth route list in `GatewayAuth` that includes generated PascalCase and lowercase legacy forms.
2. Change `_resolve_identity_and_check()` so bypass paths return the middleware identity or `ANONYMOUS`, never `SYSTEM`, while auth-disabled mode still returns `SYSTEM`.
3. Update touched Auth method contracts to use `AuthMethods.*` constants.
4. Add focused unit tests for bypass casing, anonymous identity, prefix safety, and generated public route forwarding.
5. Update `docs/GATEWAY.md` and the Gateway OpenAPI description to document canonical public Auth routes and the anonymous bypass semantics.

## Verification Strategy

- `uv run pytest tests/unit/gateway/test_auth_public_bypass.py tests/unit/gateway/test_route_generator_adminaction.py tests/unit/app/test_gateway.py -q`
- `uv run ruff check app/services/gateway/auth.py app/services/gateway/fastapi_app.py app/services/auth/service.py tests/unit/gateway/test_auth_public_bypass.py`
- `git diff --check`

## Risks and Mitigations

- Risk: adding broad prefix bypass could expose protected Auth routes. Mitigation: exact or delimiter-prefix matching only, with a negative test for `/api/Auth/LoginDebug`.
- Risk: public routes with required permissions would fail under `ANONYMOUS`. Mitigation: only login/pairing start/connect/exchange are public; protected Auth routes retain normal checks.
- Risk: stale docs imply lowercase dynamic routes are canonical. Mitigation: docs now identify PascalCase generated routes as canonical and lowercase paths as legacy compatibility where present.

## Stop Condition

PER-188 is ready for QA when the focused tests and lint pass, docs are updated, changes are committed and pushed, a PR exists, and the issue is handed to QA with branch/PR/verification evidence.
