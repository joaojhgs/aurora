# PER-188 Ultragoal Checkpoints

## Context

- Issue: PER-188 / BE-001, normalize Auth/Gateway route casing and public bypass behavior.
- Branch: `multica/PER-188-auth-gateway-route-casing`.
- Plan: `.omx/plans/PER-188-auth-gateway-route-casing.md`.
- `omx ultragoal status` showed an unrelated existing in-progress aggregate goal (`G015`), so this task records repo-local PER-188 checkpoints without mutating that active goal.

## Checkpoints

- Planning complete: source docs, code paths, invariants, acceptance criteria, and verification strategy captured before source edits.
- Implementation complete: canonical PascalCase public Auth paths and lowercase legacy paths are bypass-aware, auth-enabled bypass resolves to `ANONYMOUS`, touched Auth contracts use `AuthMethods` constants, Gateway docs name SDK-facing public endpoints, and focused regression tests cover casing, prefix safety, dependency identity, generated route forwarding, and scope enforcement.
- Verification passed:
  - `UV_CACHE_DIR=/tmp/uv-cache UV_LINK_MODE=copy /home/developer/.local/bin/uv run --extra dev --extra test-all --extra gateway pytest tests/unit/gateway/test_auth_public_bypass.py tests/unit/gateway/test_route_generator_adminaction.py tests/unit/app/test_gateway.py -q` -> 41 passed, 19 warnings.
  - `UV_CACHE_DIR=/tmp/uv-cache UV_LINK_MODE=copy /home/developer/.local/bin/uv run --extra dev --extra gateway ruff check app/services/gateway/auth.py app/services/gateway/fastapi_app.py app/services/auth/service.py tests/unit/gateway/test_auth_public_bypass.py` -> passed.
  - `git diff --check` -> passed.
