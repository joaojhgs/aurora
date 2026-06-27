# PER-222 / QA-001 — SDK/backend contract conformance CI

## Requirements Summary

- Source issue: PER-222, `QA-001 — Build SDK/backend contract conformance CI`.
- Source docs/specs read: root `AGENTS.md`, `tests/AGENTS.md`, `.omx/specs/ui-refinement/index.md`, `.omx/specs/ui-refinement/aurora-ui-sdk-contract.md`, `.omx/specs/ui-refinement/aurora-ui-ux-flows.md`, `.omx/specs/ui-refinement/feature-service-availability-graph.md`, `.omx/specs/ui-production-tasks/index.md`, `.omx/specs/ui-production-tasks/backend-gap-crosswalk.md`, `.omx/specs/ui-production-tasks/tasks/QA-001-build-sdk-backend-contract-conformance-ci.md`, `.omx/specs/ui-production-tasks/tasks/SDK-014-implement-sdk-conformance-test-suite-across-transports.md`, `.omx/specs/mesh-ui-roadmap-integration-review.md`.
- Scope is a CI and evidence gate only. Do not wire production UI, change runtime behavior, or expand into QA-002+ suites.
- Contract drift must fail across live backend inventory, Gateway OpenAPI, route/permission/exposure descriptors, SDK `backendInventoryFixture`, SDK conformance tests, and UI mock fixture references.

## Acceptance Criteria

- A dedicated GitHub Actions workflow generates backend inventory/OpenAPI artifacts, validates them against SDK fixtures, runs `@aurora/client` typecheck/test/build, and uploads sanitized evidence.
- The backend inventory generator includes a deterministic Gateway OpenAPI snapshot alongside method inventory, gateway built-ins, import errors, and UI fixture validation.
- A local checker fails on import errors, UI fixture reference errors, inventory count drift, Gateway OpenAPI route drift, SDK fixture method/route/permission/exposure drift, and obvious unredacted secret-like values in generated artifacts.
- Security/privacy evidence includes negative cases from existing SDK conformance tests: auth, permission, validation, timeout, unavailable service, unsupported feature, privacy blocked, native permission missing, and transport loss.
- A runbook documents CI commands, artifacts, owner, platforms, skipped/manual device gates, install/update/backup/diagnostics/rollback release references, and final readiness checklist cross-links.

## Implementation Steps

1. Extend `scripts/generate_backend_inventory.py` to add a Gateway OpenAPI snapshot and stable OpenAPI path summary without changing service runtime behavior.
2. Add `scripts/check_sdk_backend_conformance.py` to compare generated inventory against `packages/aurora-sdk/src/fixtures.ts` and emit evidence artifacts under `.artifacts/sdk-backend-conformance/`.
3. Add `.github/workflows/sdk-backend-contract-conformance.yml` with Python setup, backend inventory generation, checker execution, pnpm install, SDK typecheck/test/build, and artifact upload.
4. Add `docs/SDK_BACKEND_CONFORMANCE_CI.md` with the release-gate runbook and skipped/manual evidence policy.
5. Run targeted local verification: backend inventory generation/checker, SDK typecheck, SDK tests, and SDK build.

## Risks And Mitigations

- Risk: parsing a TypeScript fixture from Python can be brittle. Mitigation: parse only the stable `backendInventoryFixture` descriptor fields required for drift checks and keep failure messages explicit.
- Risk: OpenAPI only covers static Gateway built-ins in this generator context. Mitigation: dynamic method routes remain validated through method inventory route paths; OpenAPI route checks are scoped to generated built-ins.
- Risk: physical device release gates cannot run locally. Mitigation: document them as deferred/manual gates in the runbook and keep this CI job focused on SDK/backend contract conformance.

## Verification Steps

- `UV_CACHE_DIR=.uv-cache uv run python scripts/generate_backend_inventory.py --fail-on-ui-fixture-errors --output /tmp/per222-inventory.json`
- `UV_CACHE_DIR=.uv-cache uv run python scripts/check_sdk_backend_conformance.py --inventory /tmp/per222-inventory.json --evidence-dir .artifacts/sdk-backend-conformance`
- `pnpm --filter @aurora/client typecheck`
- `pnpm --filter @aurora/client test`
- `pnpm --filter @aurora/client build`
