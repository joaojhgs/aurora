# PER-189 Capability Manifest Contract Plan

## Requirements Summary

- Source task: PER-189 / BE-002, admin.overview backend/API contract gap.
- Scope: formalize a stable SDK-computed capability manifest for admin overview instead of adding a redundant Gateway endpoint, because this branch already exposes typed `Gateway.GetCapabilityCatalog`, `Gateway.GetCapabilityGraph`, `Gateway.ExplainRoute`, registry, services, health, and gateway built-in inventory surfaces.
- Source docs: `.omx/specs/ui-refinement/index.md`, `.omx/specs/ui-refinement/aurora-ui-sdk-contract.md`, `.omx/specs/ui-refinement/feature-service-availability-graph.md`, `.omx/specs/ui-production-tasks/backend-gap-crosswalk.md`.
- Code paths: `packages/aurora-sdk/src/types.ts`, `packages/aurora-sdk/src/descriptors.ts`, `packages/aurora-sdk/src/capabilities.ts`, `packages/aurora-sdk/src/client.ts`, `scripts/generate_backend_inventory.py`, `tests/unit/gateway/test_backend_inventory.py`, `packages/aurora-sdk/tests/client.test.ts`.

## Acceptance Criteria

- SDK exports a typed admin overview manifest shape that combines registry descriptors, service health, capability catalog summaries, gateway built-ins, native capability state, peer summaries, unsupported/internal-only states, and redaction/privacy assertions.
- Manifest builder is deterministic and does not invent backend truth; missing native or peer evidence is represented as unsupported/deferred.
- Backend compatibility tests verify the inventory includes Gateway capability catalog/explain/support-bundle routes and gateway built-ins required by the manifest.
- SDK tests cover the aggregate manifest fixture and unavailable/internal-only classification.

## Implementation Steps

1. Add TypeScript manifest types and builder helpers to the SDK.
2. Wire a client namespace for admin overview manifest composition using existing Gateway registry/capability catalog calls and optional caller-supplied service/builtin/native/peer evidence.
3. Extend fixtures/tests to cover stable shape, permissions/method type preservation, and unsupported native state.
4. Extend backend inventory unit tests to lock Gateway contract exposure and built-in inventory compatibility.
5. Run targeted Python unit tests, SDK typecheck/tests, and ruff on touched Python.

## Risks And Mitigations

- Risk: overclaiming runtime/native capability. Mitigation: absent evidence becomes `unsupported` or `deferred`, with `secretsRedacted=true`.
- Risk: duplicating backend endpoints. Mitigation: compose from existing typed backend contracts and inventory rather than adding another Gateway method.
- Risk: fixture drift. Mitigation: tests assert required Gateway methods and built-ins remain present.

## Verification

- `uv run pytest tests/unit/gateway/test_backend_inventory.py tests/unit/gateway/test_capability_catalog.py -q`
- `pnpm --filter @aurora/client typecheck`
- `pnpm --filter @aurora/client test`
- `uv run ruff check scripts/generate_backend_inventory.py tests/unit/gateway/test_backend_inventory.py`
