# SDK/backend contract conformance CI

## Owner

Aurora backend engineer owns this release gate. QA verifies the uploaded evidence before production readiness sign-off.

## Purpose

The `SDK Backend Contract Conformance` workflow prevents silent drift between backend contracts and the TypeScript SDK fixtures used by UI, Tauri, mobile, and mock transports.

It checks:

- live backend method inventory from `scripts/generate_backend_inventory.py`
- Gateway built-in routes and Gateway OpenAPI paths
- route, permission, method type, exposure, and model descriptor evidence
- `packages/aurora-sdk/src/fixtures.ts` `backendInventoryFixture`
- `packages/aurora-sdk/src/types.ts` backend inventory type surface
- `modules/ui-mock-reference/lib/aurora/data.ts` backend method references
- `@aurora/client` typecheck, transport conformance tests, and package build

## CI commands

The workflow runs these commands:

```bash
python scripts/generate_backend_inventory.py \
  --fail-on-ui-fixture-errors \
  --output .artifacts/sdk-backend-conformance/backend-inventory.json

python scripts/check_sdk_backend_conformance.py \
  --inventory .artifacts/sdk-backend-conformance/backend-inventory.json \
  --sdk-types packages/aurora-sdk/src/types.ts \
  --evidence-dir .artifacts/sdk-backend-conformance

pnpm --filter @aurora/client typecheck
pnpm --filter @aurora/client test
pnpm --filter @aurora/client build
```

Local sandbox runs may need:

```bash
UV_CACHE_DIR=.uv-cache uv pip install -e '.[gateway,service-auth,service-db,service-scheduler,service-tooling,service-orchestrator]'
```

## Evidence artifacts

The workflow uploads `sdk-backend-contract-conformance` with:

- `backend-inventory.json`
- `conformance-report.json`
- `backend-method-descriptors.json`
- `gateway-builtin-descriptors.json`
- `permission-exposure-matrix.json`
- `openapi-paths.json`
- `sdk-type-surface.json`

`conformance-report.json` separates fatal `issues` from non-fatal `findings`. Current non-fatal findings include backend methods not yet represented in the curated SDK fixture and optional service import warnings when audio-only dependencies are not installed. Fatal issues include stale SDK fixture methods, route/exposure drift for SDK-covered methods, UI fixture reference errors, count mismatches, OpenAPI route drift for non-doc Gateway built-ins, and possible unredacted secret-like values.

`sdk-type-surface.json` records the SDK `BackendInventory`, `BackendInventoryMethod`, and `GatewayBuiltinInventoryRoute` fields used by the checker. The CI gate fails when generated backend inventory emits an artifact field that is missing from the SDK type surface, or omits a required SDK field.

## Security and privacy negative cases

SDK conformance tests cover error normalization for:

- auth
- permission
- validation
- timeout
- unavailable service
- unsupported feature
- privacy blocked
- native permission missing
- transport loss

The backend conformance checker also scans generated artifacts for obvious unredacted secret-like values such as private keys, bearer tokens, API-key assignments, and password assignments.

## Release runbook links

- Install: `docs/INSTALL.md`
- Update and process-mode operation: `README.process-mode.md`
- Backup/restore policy and data boundaries: `docs/DATA_SHARING_POLICY.md`
- Diagnostics and support bundles: `docs/GATEWAY.md`, `docs/MESH_GAP_E2E_HARNESS.md`
- Rollback: restore the previous release artifact or container tag, restore config/DB backups according to the operator backup procedure, and rerun this conformance workflow before reopening rollout.

## Platform and skipped-test policy

This gate is contract/SDK evidence only. It does not replace:

- Tauri desktop packaging smoke logs from `tauri-desktop.yml`
- Android APK/emulator and physical/OEM matrix evidence from Android release tasks
- iOS simulator/TestFlight/device evidence from iOS release tasks
- multi-mode live backend E2E coverage from QA-002
- security/privacy adversarial regression coverage from QA-003

Emulator-only mobile evidence must stay marked as partial until physical/device/OEM evidence is attached to the relevant release issue.

## Final readiness checklist

- PER-222 / QA-001: this CI gate passes and artifact is attached.
- SDK-014: transport conformance tests pass for mock, HTTP, Tauri-local mock, and mesh mock.
- P0-002: generated backend inventory remains current.
- QA-002: live multi-mode E2E matrix is green or explicitly deferred with accepted rationale.
- QA-003: security/privacy regression suite is green.
- QA-006: release packaging and operator runbooks are linked.
- QA-007: final production readiness audit closes remaining deferred findings.
