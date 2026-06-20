# PER-194 Model Runtime Contracts Plan

## Requirements Summary

- Source issue: PER-194 / BE-007, backend/models lane.
- Scope is backend/API and SDK contract surface only; no production UI or native runtime wiring.
- Backend must provide typed model runtime/catalog/import/download/benchmark contracts so UI/SDK can show backend-proven provider state and keep unsupported/deferred mutations disabled.
- Preserve Aurora invariants: bus-only service communication, typed topic constants, IOModel payloads, PascalCase permissions, `method_type` metadata, ConfigAPI access, privacy-first redaction.

## Source Context Read

- `AGENTS.md`
- `app/services/AGENTS.md`
- `app/shared/AGENTS.md`
- `app/shared/contracts/AGENTS.md`
- `app/services/gateway/AGENTS.md`
- `app/services/auth/AGENTS.md`
- `app/messaging/AGENTS.md`
- `tests/AGENTS.md`
- `docs/CONFIG_SERVICE_PATTERN.md`
- `.omx/specs/ui-production-tasks/tasks/BE-007-add-model-runtime-catalog-import-download-benchmark-contracts.md`
- `.omx/specs/ui-refinement/index.md`
- `.omx/specs/ui-refinement/aurora-ui-sdk-contract.md`
- `.omx/specs/ui-refinement/aurora-ui-ux-flows.md`
- `.omx/specs/ui-refinement/feature-service-availability-graph.md`
- `.omx/specs/ui-production-tasks/index.md`
- `.omx/specs/ui-production-tasks/backend-gap-crosswalk.md`
- `.omx/specs/mesh-ui-roadmap-integration-review.md`

GitNexus context is requested by root guidance, but no GitNexus MCP surface is exposed in this Codex session; direct repository inspection is the fallback evidence path.

## Acceptance Criteria

- `app/shared/contracts/models/orchestrator.py` defines typed `OrchestratorMethods` and IOModel request/response shapes for model runtime, catalog, import, download, benchmark, and operation progress.
- `OrchestratorService` registers those methods with `@method_contract`, PascalCase permissions, and correct `method_type`: catalog/runtime/progress are `use`; import/download/benchmark are `manage`.
- External registry/OpenAPI inventory can discover all new routes through existing Gateway route generation.
- Read responses redact secret config values and expose provider/runtime facts: backend kind, hardware hints, model files, source/license, context window, health, benchmark state, import/download progress.
- Mutating operations do not fake success; unsupported implementation returns an explicit `unsupported` operation with reason and no side effects.
- SDK source types/descriptors expose model runtime shapes and constants without hard-coding UI runtime choices.
- Tests verify contract metadata, catalog/runtime redaction, unsupported mutation behavior, and backend inventory visibility.

## Implementation Steps

1. Add Orchestrator model-management contract models and method constants in `app/shared/contracts/models/orchestrator.py`.
2. Implement lightweight catalog/runtime helpers and contract handlers in `app/services/orchestrator/service.py`, reading current LLM config via `ConfigAPI.aget_config("services", timeout=15.0)` or equivalent async path.
3. Export new contract types from `app/shared/contracts/models/__init__.py`.
4. Add SDK TypeScript constants/types in `packages/aurora-sdk/src/descriptors.ts` and `packages/aurora-sdk/src/types.ts`; build generated `dist/` if the package build is available.
5. Add focused unit tests under `tests/unit/orchestrator/` and/or `tests/unit/gateway/` to cover metadata, registry inventory, redaction, and unsupported operation state.
6. Run targeted Python tests, targeted ruff, and SDK type/build checks where available.
7. Commit, push, open a draft PR, pin PR metadata, and hand off to QA.

## Risks And Mitigations

- Risk: accidentally inventing runtime support. Mitigation: mutation handlers return `unsupported` until a real runtime task implements side effects.
- Risk: leaking API keys or local paths. Mitigation: catalog includes provider names and file basename/status, not secret values; tests assert secrets are absent.
- Risk: generated route permissions become too broad. Mitigation: manage operations use `Orchestrator.manage`; read operations use `Orchestrator.use`.
- Risk: SDK becomes a second source of truth. Mitigation: SDK only adds typed adapter shapes/constants for backend contract responses.

## Verification

- `uv run pytest tests/unit/orchestrator/test_model_runtime_contracts.py tests/unit/gateway/test_backend_inventory.py -q`
- `uv run ruff check app/shared/contracts/models/orchestrator.py app/services/orchestrator/service.py tests/unit/orchestrator/test_model_runtime_contracts.py`
- `pnpm --filter @aurora/sdk build` if local package dependencies are usable.
